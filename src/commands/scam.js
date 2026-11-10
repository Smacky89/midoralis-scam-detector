// Scam-intel commands: teaching images/domains, reviewing what was caught.
import { AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, saveDomains, getSettings, setSetting, HASH_IMAGES_DIR, LOG_IMAGES_DIR } from '../store.js';
import { perceptualHash } from '../phash.js';
import { findMatch, learnHash, forgetHash, fetchImageBuffer, isImageAttachment } from '../scanner.js';
import { analyzeText, textScamVerdict, isAllowedDomain, isKnownScamDomain, brandImpersonation } from '../detect/text.js';
import { register } from './framework.js';
import { COLORS } from '../logging.js';
import { truncate } from '../util.js';
import { statusEmbed, statusButtons } from '../status.js';

const ADMIN = { level: 'admin', perm: PermissionFlagsBits.ManageGuild, category: 'Scam detection' };

// Hashes every image in the given attachments and adds new ones.
export async function addScamImages(atts, addedBy, note) {
  const images = atts.filter(isImageAttachment);
  let added = 0, dupes = 0, failed = 0;
  for (const att of images) {
    try {
      const buf = await fetchImageBuffer(att.url, 25 * 1024 * 1024);
      const hash = await perceptualHash(buf);
      if (findMatch(hash)) dupes++;
      else if (await learnHash(hash, buf, addedBy, note)) added++;
    } catch (e) {
      failed++;
      console.error('addscam error:', e.message);
    }
  }
  return { found: images.length, added, dupes, failed };
}

const summary = (r) =>
  `Added ${r.added} new hash(es)${r.dupes ? `, ${r.dupes} already covered` : ''}` +
  `${r.failed ? `, ${r.failed} failed to download` : ''}. Now ${db.blocklist.length} hashes.`;

register(
  {
    ...ADMIN,
    name: 'addscam',
    description: 'Teach the bot scam image(s). Attach images, or reply to a message that has them.',
    options: [
      { name: 'image', type: 'attachment', description: 'Scam image' },
      { name: 'image2', type: 'attachment', description: 'Another scam image' },
      { name: 'image3', type: 'attachment', description: 'Another scam image' },
      { name: 'note', type: 'rest', description: 'Optional note, e.g. "fake casino promo"' },
    ],
    async run(ctx) {
      const atts = [...ctx.attachments];
      if (ctx.isSlash) {
        for (const k of ['image', 'image2', 'image3']) if (ctx.opts[k]) atts.push(ctx.opts[k]);
      } else if (ctx.message.reference?.messageId) {
        const ref = await ctx.channel.messages.fetch(ctx.message.reference.messageId).catch(() => null);
        if (ref) atts.push(...ref.attachments.values());
      }
      if (!atts.some(isImageAttachment)) {
        return ctx.reply('Attach an image, or reply to a message that has the scam image. ' +
          '(Tip: right-click a message → **Apps → Add as scam image** works too.)');
      }
      const r = await addScamImages(atts, ctx.user.tag, ctx.opts.note || '');
      return ctx.reply(summary(r));
    },
  },
  {
    ...ADMIN,
    name: 'removescam',
    description: 'Remove an image hash from the blocklist.',
    options: [{ name: 'hash', type: 'string', required: true, description: 'Exact hash (see showblockedimages)' }],
    async run(ctx) {
      const ok = await forgetHash(ctx.opts.hash.toLowerCase());
      return ctx.reply(ok ? `Removed. Now ${db.blocklist.length} hashes.` : 'No hash matched. Use the exact hash string.');
    },
  },
  {
    ...ADMIN,
    name: 'adddomain',
    description: 'Add scam domain(s), space- or comma-separated.',
    options: [{ name: 'domains', type: 'rest', required: true, description: 'e.g. deezbet.com scamsite.net' }],
    async run(ctx) {
      const raw = ctx.opts.domains.split(/[\s,]+/).filter(Boolean);
      let added = 0;
      const skipped = [];
      for (const entry of raw) {
        const d = entry.toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\./, '');
        if (!d || !d.includes('.') || /\s/.test(d)) { skipped.push(`${entry} (invalid)`); continue; }
        if (isAllowedDomain(d)) { skipped.push(`${d} (on the always-allowed list)`); continue; }
        if (!db.scamDomains.has(d)) { db.scamDomains.add(d); added++; }
      }
      if (added) await saveDomains();
      return ctx.reply(`Added ${added} domain(s)${skipped.length ? `, skipped: ${skipped.join(', ')}` : ''}. ` +
        `Now ${db.scamDomains.size} learned domain(s) + ${db.feedDomains.size} from phishing feeds.`);
    },
  },
  {
    ...ADMIN,
    name: 'removedomain',
    description: 'Remove a learned scam domain.',
    options: [{ name: 'domain', type: 'string', required: true, description: 'Domain to remove' }],
    async run(ctx) {
      const d = ctx.opts.domain.toLowerCase();
      const had = db.scamDomains.delete(d);
      if (had) await saveDomains();
      if (!had && db.feedDomains.has(d)) {
        return ctx.reply(`\`${d}\` comes from a public phishing feed, not the learned list. ` +
          `To allow it in this server use \`config add allowedDomains ${d}\`.`);
      }
      return ctx.reply(had ? `Removed \`${d}\`.` : 'That domain was not in the list.');
    },
  },
  {
    ...ADMIN,
    name: 'listscam',
    aliases: ['status'],
    description: 'What\'s active, what happens to rule breakers, and whether the bot is set up correctly.',
    async run(ctx) {
      return ctx.reply({ embeds: [statusEmbed(ctx.guild)], components: [statusButtons()] });
    },
  },
  {
    ...ADMIN,
    name: 'setlogchannel',
    description: 'Make a channel (default: this one) the mod log.',
    options: [{ name: 'channel', type: 'channel', description: 'Channel to log to' }],
    async run(ctx) {
      const ch = ctx.opts.channel || ctx.channel;
      await setSetting(ctx.guild.id, 'logChannel', ch.id);
      return ctx.reply(`<#${ch.id}> is now the mod log. Removed scams, automod hits and every warn/timeout/kick/ban will be posted there.`);
    },
  },
  {
    ...ADMIN,
    name: 'removelogchannel',
    description: 'Turn the mod log off for this server.',
    async run(ctx) {
      const had = !!getSettings(ctx.guild.id).logChannel;
      await setSetting(ctx.guild.id, 'logChannel', null);
      return ctx.reply(had ? 'Mod log disabled for this server.' : 'No log channel was set.');
    },
  },
  {
    ...ADMIN,
    name: 'showlog',
    description: 'Show the last removals in this server.',
    options: [{ name: 'count', type: 'integer', min: 1, max: 10, description: 'How many (1-10, default 5)' }],
    async run(ctx) {
      const n = ctx.opts.count || 5;
      const entries = db.auditLog.filter((e) => e.guildId === ctx.guild.id).slice(-n).reverse();
      if (!entries.length) return ctx.reply('No logged removals yet.');
      const embeds = [];
      const files = [];
      for (const [i, e] of entries.entries()) {
        const embed = new EmbedBuilder()
          .setColor(e.kind === 'automod' ? COLORS.automod : COLORS.scam)
          .setTitle(`${e.kind === 'automod' ? '🛡️' : '🚫'} ${e.reason}`.slice(0, 256))
          .addFields(
            { name: 'Author', value: `${e.authorTag} (${e.authorId})`, inline: true },
            { name: 'Channel', value: `<#${e.channelId}>`, inline: true },
          )
          .setTimestamp(new Date(e.timestamp));
        if (e.content) embed.setDescription(truncate(e.content, 1000));
        const thumb = e.thumbs?.[0];
        if (thumb && existsSync(join(LOG_IMAGES_DIR, thumb))) {
          const name = `log-${i}.jpg`;
          files.push(new AttachmentBuilder(await readFile(join(LOG_IMAGES_DIR, thumb)), { name }));
          embed.setImage(`attachment://${name}`);
        }
        embeds.push(embed);
      }
      return ctx.reply({ embeds, files });
    },
  },
  {
    ...ADMIN,
    name: 'showblockedimages',
    description: 'Show the most recently blocked images.',
    options: [{ name: 'count', type: 'integer', min: 1, max: 10, description: 'How many (1-10, default 10)' }],
    async run(ctx) {
      const n = ctx.opts.count || 10;
      const entries = db.blocklist.slice(-n).reverse();
      if (!entries.length) return ctx.reply('No blocked images yet.');
      const embeds = [];
      const files = [];
      for (const [i, e] of entries.entries()) {
        const embed = new EmbedBuilder()
          .setColor(COLORS.ok)
          .setTitle((e.note || 'Blocked scam image').slice(0, 256))
          .addFields(
            { name: 'Added by', value: e.addedBy || 'unknown', inline: true },
            { name: 'Hash', value: `\`${e.hash}\``, inline: true },
          )
          .setTimestamp(new Date(e.addedAt));
        const file = join(HASH_IMAGES_DIR, `${e.hash}.jpg`);
        if (existsSync(file)) {
          const name = `blocked-${i}.jpg`;
          files.push(new AttachmentBuilder(await readFile(file), { name }));
          embed.setImage(`attachment://${name}`);
        }
        embeds.push(embed);
      }
      return ctx.reply({ embeds, files });
    },
  },
  {
    ...ADMIN,
    level: 'mod',
    perm: PermissionFlagsBits.ManageMessages,
    name: 'check',
    description: 'Test a link or message against the scam filters without posting it.',
    options: [{ name: 'text', type: 'rest', required: true, description: 'A link, domain or message text' }],
    async run(ctx) {
      const s = getSettings(ctx.guild.id);
      const a = analyzeText(ctx.opts.text, { extraAllowed: s.allowedDomains, heuristics: s.phishingHeuristics });
      const verdict = textScamVerdict(a, s);
      const lines = a.links.map((l) => {
        if (isAllowedDomain(l.domain, s.allowedDomains) && !l.homoglyph) return `✅ \`${l.domain}\`: allowed`;
        const bad = isKnownScamDomain(l.domain);
        if (bad) return `🚫 \`${l.domain}\`: known scam (${db.scamDomains.has(bad) ? 'learned list' : 'phishing feed'})`;
        const imp = brandImpersonation(l.domain);
        if (imp) return `⚠️ \`${l.domain}\`: ${imp}`;
        return `➖ \`${l.domain}\`: unknown${l.explicit ? ' link' : ''}`;
      });
      if (a.termHits.length) lines.push(`Scam words: ${a.termHits.join(', ')}`);
      if (a.phishHits.length) lines.push(`Phishing phrases: ${a.phishHits.join(', ')}`);
      const embed = new EmbedBuilder()
        .setColor(verdict ? COLORS.scam : COLORS.ok)
        .setTitle(verdict ? '🚫 Would be removed' : '✅ Would be allowed')
        .setDescription(truncate([verdict ? `**Reason:** ${verdict}` : null, ...lines].filter(Boolean).join('\n') || 'No links or scam signals found.', 4000));
      return ctx.reply({ embeds: [embed] });
    },
  },
);
