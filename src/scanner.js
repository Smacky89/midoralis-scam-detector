// The scam pipeline (links + known images + OCR) and what happens when
// something is caught, for both scams and automod rule hits.
import { AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { createWorker } from 'tesseract.js';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG } from './config.js';
import { db, saveHashes, saveAuditLog, DATA_DIR, HASH_IMAGES_DIR, LOG_IMAGES_DIR } from './store.js';
import { perceptualHash, hamming, makeThumbnail, prepareForOcr } from './phash.js';
import { analyzeText, textScamVerdict, ocrScamVerdict, isAllowedDomain } from './detect/text.js';
import { forgetMessages, recentMessages } from './automod.js';
import { applyAutoAction, describeAction } from './moderation.js';
import { sendModLog, quickActionRow, COLORS } from './logging.js';
import { createLimiter, withTimeout, LruSet, truncate } from './util.js';

// ── known image hashes ───────────────────────────────────────
export function findMatch(hash) {
  let best = null;
  for (const entry of db.blocklist) {
    const dist = hamming(hash, entry.hash);
    if (dist <= CONFIG.matchThreshold && (!best || dist < best.dist)) best = { entry, dist };
  }
  return best;
}

export async function learnHash(hash, buffer, addedBy, note) {
  if (findMatch(hash)) return false;
  db.blocklist.push({ hash, addedBy, addedAt: new Date().toISOString(), note });
  cleanImages.delete(hash);
  const thumb = await makeThumbnail(buffer);
  if (thumb) {
    await mkdir(HASH_IMAGES_DIR, { recursive: true });
    await writeFile(join(HASH_IMAGES_DIR, `${hash}.jpg`), thumb);
  }
  await saveHashes();
  return true;
}

export async function forgetHash(hash) {
  const before = db.blocklist.length;
  db.blocklist = db.blocklist.filter((e) => e.hash !== hash);
  if (db.blocklist.length === before) return false;
  await unlink(join(HASH_IMAGES_DIR, `${hash}.jpg`)).catch(() => {});
  cleanImages.add(hash); // don't immediately re-learn it via OCR
  await saveHashes();
  return true;
}

export async function fetchImageBuffer(url, maxBytes = CONFIG.maxImageBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error(`image too large (${len} bytes)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`image too large (${buf.length} bytes)`);
  return buf;
}

// ── OCR (one lazy worker, jobs queued one at a time) ─────────
let ocrWorker = null;
const ocrLimit = createLimiter(1);
const cleanImages = new LruSet(CONFIG.cleanImageCacheSize);

let ocrDisabledUntil = 0;
let ocrFailures = 0;

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (Date.now() < ocrDisabledUntil) throw new Error('OCR unavailable (language data failed to load recently)');
  const cachePath = join(DATA_DIR, 'tessdata');
  await mkdir(cachePath, { recursive: true });

  // tesseract.js never settles createWorker() if the language download
  // fails, so race it against its own error handler and a timeout.
  let started = false;
  let failStartup;
  const startupError = new Promise((_, reject) => { failStartup = reject; });
  startupError.catch(() => {});
  try {
    ocrWorker = await withTimeout(Promise.race([
      createWorker('eng', 1, {
        // Cache the ~10 MB language file on the data volume so redeploys
        // don't re-download it. OCR_LANG_PATH can point at a local folder or
        // mirror if the default CDN (jsdelivr) is unreachable.
        cachePath,
        ...(process.env.OCR_LANG_PATH ? { langPath: process.env.OCR_LANG_PATH } : {}),
        // Without this, a failed download throws an uncaught error and kills the bot.
        errorHandler: (e) => {
          console.error('OCR worker error:', e);
          if (!started) failStartup(e);
        },
      }),
      startupError,
    ]), 180_000, 'OCR startup');
    started = true;
    ocrFailures = 0;
    console.log('OCR worker ready.');
    return ocrWorker;
  } catch (e) {
    ocrWorker = null;
    ocrFailures++;
    const backoff = Math.min(10 * 60_000 * 2 ** (ocrFailures - 1), 6 * 3_600_000);
    ocrDisabledUntil = Date.now() + backoff;
    throw new Error(`OCR worker failed to start (retrying in ${Math.round(backoff / 60_000)} min): ${e.message || e}`);
  }
}

// The OCR engine holds ~120 MB of RAM, so unload it when no images have
// needed OCR for a while. It restarts in ~1s from the on-disk cache.
let idleTimer = null;
function scheduleIdleShutdown() {
  clearTimeout(idleTimer);
  if (CONFIG.ocrIdleShutdownMinutes <= 0) return;
  idleTimer = setTimeout(() => {
    if (ocrLimit.pending === 0 && ocrWorker) {
      shutdownOcr();
      console.log('OCR worker unloaded (idle).');
    }
  }, CONFIG.ocrIdleShutdownMinutes * 60_000);
  idleTimer.unref();
}

async function ocr(buffer) {
  scheduleIdleShutdown();
  return ocrLimit(async () => {
    const worker = await getOcrWorker();
    const input = await prepareForOcr(buffer);
    try {
      const { data } = await withTimeout(worker.recognize(input), CONFIG.ocrTimeoutMs, 'OCR');
      return data.text || '';
    } catch (e) {
      // A timed-out worker may be wedged, so start a fresh one next time.
      if (/timed out/.test(e.message)) {
        const w = ocrWorker;
        ocrWorker = null;
        w?.terminate().catch(() => {});
      }
      throw e;
    }
  });
}

export async function shutdownOcr() {
  const w = ocrWorker;
  ocrWorker = null;
  await w?.terminate().catch(() => {});
}

// ── image sources in a message ───────────────────────────────
export function isImageAttachment(att) {
  return att.contentType?.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(att.name ?? '');
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function messageImages(msg, extraAllowed = [], { attachments = true, embeds = true } = {}) {
  const out = [];
  for (const att of attachments ? msg.attachments.values() : []) {
    if (isImageAttachment(att)) out.push({ url: att.url, name: att.name, size: att.size });
  }
  // Images from link embeds (e.g. a scam site's preview card). Skip trusted
  // hosts like tenor/giphy so every GIF reaction isn't downloaded + OCR'd.
  for (const embed of embeds ? msg.embeds || [] : []) {
    for (const img of [embed.image, embed.thumbnail]) {
      if (!img?.url) continue;
      const host = hostOf(img.url);
      if (!host || isAllowedDomain(host, extraAllowed)) continue;
      const pageHost = embed.url && hostOf(embed.url);
      if (pageHost && isAllowedDomain(pageHost, extraAllowed)) continue;
      out.push({ url: img.proxyURL || img.url, name: 'embed-image.png', size: 0 });
    }
  }
  const seen = new Set();
  return out.filter((i) => !seen.has(i.url) && seen.add(i.url)).slice(0, 10);
}

// ── the scam scan ────────────────────────────────────────────
// Returns null, or { reason, images: [{buffer,name}], learned: [hash] }.
// Options let edits re-check only what changed (new text, new link embeds).
export async function scanForScam(msg, settings, { text = true, attachments = true, embeds = true } = {}) {
  const extraAllowed = settings.allowedDomains;

  // 1. Text: known scam domains, lookalike domains, phishing bait.
  if (text && msg.content) {
    const everyoneAttempt = /@(everyone|here)/.test(msg.content) &&
      !msg.member?.permissions.has(PermissionFlagsBits.MentionEveryone);
    const analysis = analyzeText(msg.content, { extraAllowed, heuristics: settings.phishingHeuristics });
    const reason = textScamVerdict(analysis, settings, { everyoneAttempt });
    if (reason) return { reason, images: [], learned: [] };
  }

  // 2. Images: known hashes first (instant), then OCR for new ones.
  const images = messageImages(msg, extraAllowed, { attachments, embeds });
  if (!images.length) return null;

  const pending = [];
  for (const img of images) {
    if (img.size > CONFIG.maxImageBytes) continue;
    try {
      const buffer = await fetchImageBuffer(img.url);
      const hash = await perceptualHash(buffer);
      const match = findMatch(hash);
      if (match) {
        const note = match.entry.note ? `, "${match.entry.note}"` : '';
        return { reason: `known scam image (dist ${match.dist}${note})`, images: [{ buffer, name: img.name }], learned: [] };
      }
      pending.push({ buffer, hash, name: img.name });
    } catch (e) {
      console.error('image scan error:', e.message);
    }
  }

  if (!CONFIG.enableOcr || !pending.length) return null;
  if (ocrLimit.pending > CONFIG.ocrMaxQueue) {
    console.warn(`OCR queue full (${ocrLimit.pending}), skipping OCR for message ${msg.id}`);
    return null;
  }

  const results = [];
  for (const p of pending) {
    if (cleanImages.has(p.hash)) continue; // seen recently and it was fine
    try {
      const text = await ocr(p.buffer);
      const analysis = analyzeText(text, { extraAllowed, ocr: true });
      const reason = ocrScamVerdict(analysis);
      if (reason) {
        const learned = [];
        if (CONFIG.autoLearnFromOcr &&
            await learnHash(p.hash, p.buffer, 'auto-ocr', `OCR: ${analysis.knownBad || [...analysis.termHits, ...analysis.phishHits].slice(0, 3).join(', ')}`)) {
          learned.push(p.hash);
        }
        return { reason, images: [{ buffer: p.buffer, name: p.name }], learned };
      }
      results.push({ ...p, analysis });
    } catch (e) {
      console.error('OCR error:', e.message);
    }
  }

  // Multi-image scams: signals spread across several pictures.
  if (results.length > 1) {
    const merged = {
      termHits: [...new Set(results.flatMap((r) => r.analysis.termHits))],
      phishHits: [...new Set(results.flatMap((r) => r.analysis.phishHits))],
      knownBad: results.find((r) => r.analysis.knownBad)?.analysis.knownBad || null,
      unknownUrl: results.some((r) => r.analysis.unknownUrl),
    };
    const reason = ocrScamVerdict(merged, `across ${results.length} images`);
    if (reason) {
      const learned = [];
      if (CONFIG.autoLearnFromOcr) {
        const note = `OCR (multi-image): ${merged.knownBad || [...merged.termHits, ...merged.phishHits].slice(0, 3).join(', ')}`;
        for (const r of results) if (await learnHash(r.hash, r.buffer, 'auto-ocr', note)) learned.push(r.hash);
      }
      return { reason, images: results.map((r) => ({ buffer: r.buffer, name: r.name })), learned };
    }
  }

  for (const r of results) cleanImages.add(r.hash);
  return null;
}

// ── audit log (for !showlog) ─────────────────────────────────
async function recordAuditEntry(msg, reason, images = [], kind = 'scam') {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    guildId: msg.guild.id,
    authorTag: msg.author.tag,
    authorId: msg.author.id,
    channelId: msg.channel.id,
    reason,
    content: msg.content ? msg.content.slice(0, 300) : '',
    timestamp: msg.createdAt.toISOString(),
    thumbs: [],
  };
  for (const img of images.slice(0, CONFIG.maxLogAttachments)) {
    const thumb = await makeThumbnail(img.buffer);
    if (!thumb) continue;
    const filename = `${entry.id}-${entry.thumbs.length}.jpg`;
    await mkdir(LOG_IMAGES_DIR, { recursive: true });
    await writeFile(join(LOG_IMAGES_DIR, filename), thumb);
    entry.thumbs.push(filename);
  }
  db.auditLog.push(entry);
  if (db.auditLog.length > CONFIG.maxAuditLogEntries) {
    const pruned = db.auditLog.splice(0, db.auditLog.length - CONFIG.maxAuditLogEntries);
    for (const p of pruned) for (const f of p.thumbs) await unlink(join(LOG_IMAGES_DIR, f)).catch(() => {});
  }
  saveAuditLog();
}

// ── acting on a detection ────────────────────────────────────
// Messages we've already dealt with (e.g. purged as part of someone's spam
// burst) so concurrent handlers don't double-log/double-punish them.
const handled = new LruSet(5000);
export const wasHandled = (id) => handled.has(id);

async function deleteMessages(guild, refs) {
  const byChannel = new Map();
  for (const r of refs) {
    handled.add(r.id);
    if (!byChannel.has(r.channelId)) byChannel.set(r.channelId, []);
    byChannel.get(r.channelId).push(r.id);
  }
  let deleted = 0;
  for (const [channelId, ids] of byChannel) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch?.isTextBased()) continue;
    try {
      if (ids.length === 1) {
        await ch.messages.delete(ids[0]);
        deleted++;
      } else {
        const res = await ch.bulkDelete(ids, true);
        deleted += res.size;
      }
    } catch {
      // already gone / missing permissions, nothing useful to do
    }
  }
  return deleted;
}

async function postNotice(channel, text, seconds) {
  const sent = await channel.send({ content: text, allowedMentions: { users: [] } }).catch(() => null);
  if (sent && seconds > 0) setTimeout(() => sent.delete().catch(() => {}), seconds * 1000);
}

// Posts the removal embed (+ re-uploaded images) to the mod log.
async function logRemoval(msg, { title, color, reason, images = [], extra = [], unlearnHash }) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .addFields(
      { name: 'Author', value: `<@${msg.author.id}> \`${msg.author.tag}\` (${msg.author.id})`, inline: true },
      { name: 'Channel', value: `<#${msg.channel.id}>`, inline: true },
      { name: 'Reason', value: truncate(reason, 1000) },
      ...extra,
    )
    .setTimestamp(msg.createdAt);
  if (msg.content) embed.addFields({ name: 'Message text', value: truncate(msg.content, 1000) });
  const files = images.slice(0, CONFIG.maxLogAttachments).map((img, i) =>
    new AttachmentBuilder(img.buffer, { name: img.name || `image-${i}.png` }));
  await sendModLog(msg.guild, {
    embeds: [embed], files,
    components: [quickActionRow(msg.author.id, { unlearnHash })],
  });
}

const compromisedDm = (guild) =>
  `A message you just sent in **${guild.name}** was removed because it looked like a scam.\n` +
  'If you didn\'t send it, **your account may be compromised**: change your password, turn on ' +
  '2-factor authentication, and check *Settings → Authorized Apps* for anything you don\'t recognise.';

export async function handleScam(msg, result, settings) {
  if (handled.has(msg.id)) return;
  handled.add(msg.id);
  if (settings.monitorOnly) {
    await logRemoval(msg, {
      title: '👀 [Monitor mode] Would have removed scam', color: COLORS.info,
      reason: result.reason, images: result.images,
    });
    return;
  }

  await msg.delete().catch(() => {});
  let purged = 0;
  if (settings.scamPurgeRecent) {
    const others = recentMessages(msg.guild.id, msg.author.id, 2 * 60_000)
      .filter((m) => m.id !== msg.id && !handled.has(m.id));
    purged = await deleteMessages(msg.guild, others);
  }
  forgetMessages(msg.guild.id, msg.author.id, [msg.id, ...recentMessages(msg.guild.id, msg.author.id, 2 * 60_000)
    .filter((m) => handled.has(m.id)).map((m) => m.id)]);
  if (CONFIG.notice) await postNotice(msg.channel, `🚫 ${CONFIG.notice}`, CONFIG.noticeDeleteAfterSeconds);
  if (settings.scamDmUser) await msg.author.send(compromisedDm(msg.guild)).catch(() => {});

  const punishment = await applyAutoAction(msg.guild, msg.author, settings.scamAction,
    `Scam: ${result.reason}`, settings.scamTimeout, { silent: true });

  await recordAuditEntry(msg, result.reason, result.images, 'scam');
  const extra = [];
  if (purged) extra.push({ name: 'Also removed', value: `${purged} recent message(s) from this user`, inline: true });
  if (punishment) {
    extra.push({
      name: 'Action',
      value: punishment.ok ? `${describeAction(settings.scamAction, settings.scamTimeout)} (case #${punishment.case.id})`
        : `${settings.scamAction} failed: ${punishment.error}`,
      inline: true,
    });
  }
  await logRemoval(msg, {
    title: '🚫 Scam message removed', color: COLORS.scam,
    reason: result.reason, images: result.images, extra,
    unlearnHash: result.learned[0],
  });
  console.log(`[${msg.guild.name}] Blocked scam from ${msg.author.tag} (${result.reason})`);
}

// Per-user cooldown so one burst of spam doesn't stack five warnings.
const lastPunished = new Map();

const RULE_LABELS = {
  duplicate: 'repeated message spam', spam: 'sending messages too fast', mentions: 'mass mentions',
  badwords: 'blocked word', invites: 'server invites aren\'t allowed', newmember: 'new members can\'t post links yet',
  links: 'links aren\'t allowed here', zalgo: 'glitch text', caps: 'too many capital letters',
  emoji: 'too many emojis', wall: 'message too long',
};

export async function handleViolation(msg, v, settings) {
  if (handled.has(msg.id)) return;
  handled.add(msg.id);
  if (settings.monitorOnly) {
    await logRemoval(msg, {
      title: `👀 [Monitor mode] AutoMod would act: ${v.rule}`, color: COLORS.info,
      reason: `${v.reason} → ${describeAction(v.action, settings.automodTimeout)}`,
    });
    return;
  }

  await deleteMessages(msg.guild, v.messages);
  forgetMessages(msg.guild.id, msg.author.id, v.messages.map((m) => m.id));
  await postNotice(msg.channel, `⚠️ <@${msg.author.id}>, your message was removed: ${RULE_LABELS[v.rule] || v.rule}.`, 8);

  const key = `${msg.guild.id}:${msg.author.id}`;
  const recentlyPunished = Date.now() - (lastPunished.get(key) || 0) < 15_000;
  let punishment = null;
  if (v.action !== 'delete' && !recentlyPunished) {
    lastPunished.set(key, Date.now());
    punishment = await applyAutoAction(msg.guild, msg.author, v.action, `AutoMod: ${v.reason}`,
      settings.automodTimeout, { silent: true });
  }

  await recordAuditEntry(msg, `AutoMod (${v.rule}): ${v.reason}`, [], 'automod');
  const extra = [];
  if (v.messages.length > 1) extra.push({ name: 'Messages removed', value: `${v.messages.length}`, inline: true });
  if (punishment) {
    extra.push({
      name: 'Action',
      value: punishment.ok ? `${describeAction(v.action, settings.automodTimeout)} (case #${punishment.case.id})` : `${v.action} failed: ${punishment.error}`,
      inline: true,
    });
  }
  await logRemoval(msg, { title: `🛡️ AutoMod: ${v.rule}`, color: COLORS.automod, reason: v.reason, extra });
}

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [k, t] of lastPunished) if (t < cutoff) lastPunished.delete(k);
}, 60_000).unref();
