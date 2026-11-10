// AutoMod rules. Each rule looks at one message (plus that user's recent
// history) and returns a violation or nothing. The rules themselves don't
// touch Discord. Actions are carried out by moderation.js.
import { extractLinks, extractInvites, isAllowedDomain, normalize, normalizeForWords } from './detect/text.js';

// ── recent-message tracker (per guild+user, in memory) ───────
const HISTORY_MS = 5 * 60_000;
const history = new Map(); // `${guildId}:${userId}` -> [{ id, channelId, ts, sig }]

function messageSignature(msg) {
  const text = normalize(msg.content).replace(/\s+/g, ' ').trim();
  const files = [...msg.attachments.values()].map((a) => `${a.size}`).join(',');
  const hasLink = /https?:\/\/|discord\.gg/.test(text);
  // Short chatter ("lol", "ok") isn't worth duplicate detection.
  if (text.length < 10 && !files && !hasLink) return null;
  return `${text}|${files}`;
}

export function recordMessage(msg) {
  const key = `${msg.guild.id}:${msg.author.id}`;
  const list = history.get(key) || [];
  const now = msg.createdTimestamp || Date.now();
  list.push({ id: msg.id, channelId: msg.channel.id, ts: now, sig: messageSignature(msg) });
  while (list.length && now - list[0].ts > HISTORY_MS) list.shift();
  history.set(key, list);
}

export function recentMessages(guildId, userId, withinMs) {
  const list = history.get(`${guildId}:${userId}`) || [];
  const cutoff = Date.now() - withinMs;
  return list.filter((m) => m.ts >= cutoff);
}

export function forgetMessages(guildId, userId, ids) {
  const key = `${guildId}:${userId}`;
  const drop = new Set(ids);
  const list = (history.get(key) || []).filter((m) => !drop.has(m.id));
  if (list.length) history.set(key, list);
  else history.delete(key);
}

setInterval(() => {
  const cutoff = Date.now() - HISTORY_MS;
  for (const [key, list] of history) {
    if (!list.length || list[list.length - 1].ts < cutoff) history.delete(key);
  }
}, 60_000).unref();

// ── individual text checks (pure) ────────────────────────────
export function capsRatio(text) {
  const letters = text.replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|https?:\/\/\S+/g, '').match(/\p{L}/gu) || [];
  if (letters.length < 12) return 0;
  const upper = letters.filter((c) => c !== c.toLowerCase()).length;
  return Math.round((upper / letters.length) * 100);
}

export function countEmojis(text) {
  const custom = (text.match(/<a?:\w+:\d+>/g) || []).length;
  const unicode = (text.replace(/<a?:\w+:\d+>/g, '').match(/\p{Extended_Pictographic}/gu) || []).length;
  return custom + unicode;
}

export function isZalgo(text) {
  const marks = (text.match(/\p{M}/gu) || []).length;
  const letters = (text.match(/\p{L}/gu) || []).length || 1;
  return marks >= 8 && marks / letters > 0.5;
}

// Returns the first bad word found, or null. Entries ending in * match word
// prefixes; entries with spaces match phrases. Spaced-out letters
// ("b a d w o r d") and leetspeak ("b4dw0rd") are normalised first.
export function findBadWord(text, badWords) {
  if (!badWords.length) return null;
  const norm = normalizeForWords(text);
  const tokens = norm.split(/[^\p{L}]+/u).filter(Boolean);
  // Join runs of single letters: "b a d" -> "bad"
  const joined = [];
  let run = '';
  for (const t of tokens) {
    if (t.length === 1) run += t;
    else {
      if (run.length > 1) joined.push(run);
      run = '';
    }
  }
  if (run.length > 1) joined.push(run);
  const words = new Set([...tokens, ...joined].map((w) => w.replace(/(.)\1{2,}/g, '$1$1')));
  const spaced = ` ${tokens.join(' ')} `;

  for (const raw of badWords) {
    const entry = normalizeForWords(raw).trim();
    if (!entry) continue;
    if (entry.includes(' ')) {
      if (spaced.includes(` ${entry} `)) return raw;
    } else if (entry.endsWith('*')) {
      const stem = entry.slice(0, -1);
      for (const w of words) if (w.startsWith(stem)) return raw;
    } else if (words.has(entry)) {
      return raw;
    }
  }
  return null;
}

// ── the rule runner ──────────────────────────────────────────
// ctx: { settings, member, isEdit, resolveInvite(code) -> guildId|null }
// Returns { rule, reason, action, messages: [{ id, channelId }] } or null.
export async function runAutomod(msg, ctx) {
  const s = ctx.settings;
  const content = msg.content || '';
  const self = [{ id: msg.id, channelId: msg.channel.id }];
  const hit = (rule, reason, action = s.automodAction, messages = self) =>
    ({ rule, reason, action, messages });

  // Flood / duplicate checks use message history, so they come first
  // (and don't apply to edits, which aren't new messages).
  if (s.antiDuplicate && !ctx.isEdit) {
    const sig = messageSignature(msg);
    if (sig) {
      const same = recentMessages(msg.guild.id, msg.author.id, s.duplicateWindow).filter((m) => m.sig === sig);
      if (same.length >= s.duplicateCount) {
        const channels = new Set(same.map((m) => m.channelId)).size;
        return hit('duplicate', `same message posted ${same.length}× in ${channels} channel(s)`,
          s.duplicateAction, same);
      }
    }
  }
  if (s.antiSpam && !ctx.isEdit) {
    const recent = recentMessages(msg.guild.id, msg.author.id, s.spamWindow);
    if (recent.length >= s.spamMessages) {
      return hit('spam', `${recent.length} messages in ${Math.round(s.spamWindow / 1000)}s`,
        s.automodAction, recent);
    }
  }

  if (!content) return null;

  if (s.antiMassMention) {
    const count = msg.mentions.users.size + msg.mentions.roles.size;
    if (count > s.maxMentions) return hit('mentions', `${count} mentions (max ${s.maxMentions})`);
  }

  if (s.badWords.length) {
    const word = findBadWord(content, s.badWords);
    if (word) return hit('badwords', `blocked word "${word}"`, s.badWordsAction);
  }

  if (s.antiInvites) {
    for (const code of extractInvites(content)) {
      const target = await ctx.resolveInvite(code);
      if (target !== msg.guild.id) return hit('invites', `invite to another server (${code})`, 'delete');
    }
  }

  const links = extractLinks(content).filter((l) => l.explicit && !isAllowedDomain(l.domain, s.allowedDomains));
  if (links.length) {
    if (s.newMemberLinkMinutes > 0 && ctx.member?.joinedTimestamp &&
        Date.now() - ctx.member.joinedTimestamp < s.newMemberLinkMinutes * 60_000) {
      return hit('newmember', `new member link (${links[0].domain}), joined under ${s.newMemberLinkMinutes} min ago`, 'delete');
    }
    if (s.antiLinks) return hit('links', `link to ${links[0].domain} (not an allowed domain)`, 'delete');
  }

  if (s.antiZalgo && isZalgo(content)) return hit('zalgo', 'zalgo / glitch text', 'delete');
  if (s.antiCaps) {
    const pct = capsRatio(content);
    if (pct >= s.capsPercent) return hit('caps', `${pct}% capital letters`, 'delete');
  }
  if (s.antiEmojiSpam) {
    const n = countEmojis(content);
    if (n > s.maxEmojis) return hit('emoji', `${n} emojis (max ${s.maxEmojis})`, 'delete');
  }
  if (s.antiWallText) {
    const lines = content.split('\n').length;
    if (lines > s.maxLines) return hit('wall', `${lines} lines (max ${s.maxLines})`, 'delete');
  }
  return null;
}
