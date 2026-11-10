// Text analysis: link extraction, domain reputation, phishing heuristics.
// Everything in here is pure (no Discord objects) so it is easy to unit test.
import { domainToUnicode } from 'node:url';
import { CONFIG } from '../config.js';
import { db } from '../store.js';

// ── normalisation ────────────────────────────────────────────
// Characters scammers swap in to dodge filters (Cyrillic/Greek lookalikes,
// fullwidth letters are handled by NFKC).
const CONFUSABLES = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ԁ: 'd', ѕ: 's',
  ӏ: 'l', ɡ: 'g', ո: 'n', ս: 'u', ᴅ: 'd', ɪ: 'i', ʟ: 'l', ᴏ: 'o', ʀ: 'r', ᴄ: 'c',
  α: 'a', ε: 'e', ο: 'o', ρ: 'p', τ: 't', υ: 'u', ν: 'v', κ: 'k', ι: 'i', ѵ: 'v',
};
const ZERO_WIDTH = /[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g;

export function normalize(text) {
  return (text || '')
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .toLowerCase()
    .replace(/[^\p{ASCII}]/gu, (ch) => CONFUSABLES[ch] ?? ch);
}

// For word filters: also undo leetspeak and strip separators ("b.a.d", "b 4 d").
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'l' };
export function normalizeForWords(text) {
  return normalize(text)
    .replace(/[\p{M}]/gu, '')
    .replace(/[0-9@$!|]/g, (c) => LEET[c] ?? c);
}

// ── link extraction ──────────────────────────────────────────
// File extensions that look like TLDs in plain text ("index.js", "cat.png").
const NOT_TLDS = new Set([
  'js', 'ts', 'py', 'rb', 'go', 'rs', 'cs', 'cpp', 'java', 'kt', 'lua', 'php', 'sh', 'bat', 'ps1',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'mp3', 'mp4', 'wav', 'mov', 'mkv', 'webm',
  'txt', 'md', 'json', 'yml', 'yaml', 'xml', 'csv', 'log', 'ini', 'cfg', 'toml', 'lock',
  'exe', 'dll', 'zip', 'rar', 'tar', 'gz', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'html', 'htm', 'css',
  'jar', 'apk', 'iso', 'bin', 'dat', 'tmp', 'bak', 'old', 'map', 'mjs', 'cjs', 'jsx', 'tsx', 'vue',
]);

const EXPLICIT_URL = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+/gi;
// Unicode-aware so "dіscord.com" (Cyrillic і) is captured whole, then punycoded.
const BARE_DOMAIN = /(?<![\p{L}\p{N}.-])((?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]+|[a-z]{2,24}))(?![\p{L}\p{N}-])/giu;
const MASKED_LINK = /\[([^\]]{1,200})\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/gi;

function hostnameOf(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`);
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
}

// Unicode (IDN) hostnames are decoded and mapped to plain ASCII lookalikes,
// so "dіscord.com" (Cyrillic і) becomes "discord.com" for brand checks.
function skeleton(domain) {
  const uni = domain.includes('xn--') ? domainToUnicode(domain) || domain : domain;
  return normalize(uni);
}

// Returns [{ domain, explicit, homoglyph }]; `explicit` means it was written
// as a real link (scheme or www.), not just "something.xyz" in prose.
export function extractLinks(text) {
  const raw = (text || '').normalize('NFKC').replace(ZERO_WIDTH, '');
  const seen = new Map();
  const add = (domain, explicit) => {
    if (!domain || !domain.includes('.')) return;
    const prev = seen.get(domain);
    if (prev) prev.explicit ||= explicit;
    else seen.set(domain, { domain, explicit, homoglyph: false });
  };

  // The URL parser lowercases and punycodes non-ASCII hostnames for us.
  for (const m of raw.matchAll(EXPLICIT_URL)) add(hostnameOf(m[0]), true);
  for (const m of raw.matchAll(BARE_DOMAIN)) {
    const tld = m[1].slice(m[1].lastIndexOf('.') + 1).toLowerCase();
    if (!NOT_TLDS.has(tld)) add(hostnameOf(m[1]), false);
  }
  for (const link of seen.values()) {
    link.homoglyph = link.domain.includes('xn--') && skeleton(link.domain) !== link.domain;
  }
  return [...seen.values()];
}

// [shown text](https://actual) where shown text claims to be a different site.
export function maskedLinkMismatches(text) {
  const out = [];
  for (const m of (text || '').matchAll(MASKED_LINK)) {
    const shownHost = extractLinks(m[1])[0]?.domain;
    const actualHost = hostnameOf(m[2]);
    if (shownHost && actualHost && registrable(shownHost) !== registrable(actualHost)) {
      out.push({ shown: shownHost, actual: actualHost });
    }
  }
  return out;
}

// ── domain reputation ────────────────────────────────────────
// "a.b.evil.com" → ["a.b.evil.com", "b.evil.com", "evil.com"]
function suffixes(domain) {
  const parts = domain.split('.');
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  return out;
}

// Rough registrable domain (good enough for comparisons, no PSL needed).
const TWO_PART_TLDS = /\.(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/;
function registrable(domain) {
  const parts = domain.split('.');
  const n = TWO_PART_TLDS.test(domain) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export function isAllowedDomain(domain, extraAllowed = []) {
  const s = suffixes(domain);
  return CONFIG.allowedDomains.some((d) => s.includes(d)) || extraAllowed.some((d) => s.includes(d));
}

export function isKnownScamDomain(domain) {
  return suffixes(domain).find((d) => db.scamDomains.has(d) || db.feedDomains.has(d)) || null;
}

// Optimal-string-alignment distance (Levenshtein + adjacent transpositions).
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

const BAIT_WORDS = /(gift|nitro|free|claim|promo|drop|login|verify|auth|trade|airdrop|event|bonus|reward|giveaway|wallet|mint|support|appeal|security)/;
const SUSPICIOUS_TLDS = new Set([
  'gift', 'ru', 'xyz', 'top', 'click', 'link', 'site', 'online', 'fun', 'shop', 'icu', 'cfd', 'sbs',
  'live', 'store', 'info', 'pw', 'tk', 'ml', 'ga', 'cf', 'gq', 'rest', 'cyou', 'monster', 'buzz',
  'club', 'space', 'website', 'digital', 'su', 'cn', 'art', 'lol', 'today', 'bond', 'work',
]);

// Brands where even a lone lookalike domain (no bait words) is damning:
// these names have no common English near-misses.
const STRICT_BRANDS = new Set(['discord', 'discordapp', 'steamcommunity', 'steampowered', 'epicgames', 'roblox']);
const REAL_WORDS = new Set(['discard', 'discordia', 'discords', 'disco', 'discos', 'discover', 'stream', 'finance', 'telegraf', 'switch', 'glitch', 'goggle', 'goggles', 'coinbag']);

// Returns a human-readable reason if this domain impersonates a protected
// brand (lookalike spelling, brand + bait word, or Unicode homoglyphs).
export function brandImpersonation(domain) {
  const skel = skeleton(domain);
  const labels = skel.split('.');
  const tld = labels[labels.length - 1];
  const body = labels.slice(0, -1);
  const suspiciousContext = BAIT_WORDS.test(skel) || SUSPICIOUS_TLDS.has(tld);

  if (domain.includes('xn--') && isAllowedDomain(skel)) {
    return `"${domain}" uses look-alike characters to imitate ${skel}`;
  }

  for (const label of body) {
    const candidates = new Set([label, label.replace(/-/g, ''), ...label.split('-')]);
    for (const c of candidates) {
      if (c.length < 4 || REAL_WORDS.has(c)) continue;
      for (const brand of CONFIG.protectedBrands) {
        if (c === brand) {
          // Exact brand inside an unofficial domain: discord-gift.ru, steamcommunity.com.ru
          if (suspiciousContext) return `"${domain}" pretends to be ${brand}`;
          continue;
        }
        if (brand.length < 6) continue; // too short for spelling checks (steam/stream)
        const dist = editDistance(c, brand);
        const maxDist = suspiciousContext ? 2 : STRICT_BRANDS.has(brand) ? 1 : 0;
        if (dist <= maxDist) return `"${domain}" is a lookalike of ${brand}`;
      }
    }
  }
  return null;
}

// ── invites ──────────────────────────────────────────────────
const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.(?:gg|io|me|li)|dsc\.gg|invite\.gg)\/([a-z0-9-]{2,32})/gi;
export function extractInvites(text) {
  return [...normalize(text).matchAll(INVITE_RE)].map((m) => m[1]);
}

// ── scam scoring ─────────────────────────────────────────────
// Everything a caller might want to know about a piece of text.
export function analyzeText(text, { extraAllowed = [], heuristics = true, ocr = false } = {}) {
  const lower = normalize(text);
  const squashed = lower.replace(/\s+/g, ' ');
  const termHits = CONFIG.scamTerms.filter((t) => squashed.includes(t));
  const phishHits = CONFIG.phishingPhrases.filter((t) => squashed.includes(t));
  const links = extractLinks(text);

  let knownBad = null;
  let impersonation = null;
  let unknownUrl = false;
  for (const link of links) {
    if (isAllowedDomain(link.domain, extraAllowed) && !link.homoglyph) continue;
    const bad = isKnownScamDomain(link.domain);
    if (bad) {
      knownBad ??= bad;
      continue;
    }
    // OCR output is too noisy for spelling-based lookalike checks.
    if (heuristics && !ocr) impersonation ??= brandImpersonation(link.domain);
    if (link.explicit || ocr) unknownUrl = true;
  }

  const masked = ocr ? [] : maskedLinkMismatches(text).filter(
    (m) => isAllowedDomain(m.shown) && !isAllowedDomain(m.actual, extraAllowed)
  );

  return { termHits, phishHits, links, knownBad, impersonation, unknownUrl, masked };
}

// Decides whether a plain-text message is a scam. Returns a reason or null.
export function textScamVerdict(analysis, settings, { everyoneAttempt = false } = {}) {
  const a = analysis;
  if (a.knownBad) return `known scam link "${a.knownBad}"`;
  if (settings.phishingHeuristics) {
    if (a.impersonation) return `phishing link: ${a.impersonation}`;
    if (a.masked.length) return `disguised link: shows ${a.masked[0].shown} but goes to ${a.masked[0].actual}`;
    if (a.phishHits.length && a.unknownUrl) return `phishing bait (${a.phishHits.slice(0, 2).join(', ')}) + unknown link`;
    if (everyoneAttempt && a.unknownUrl && (a.termHits.length || a.phishHits.length)) {
      return `@everyone + scam words (${[...a.phishHits, ...a.termHits].slice(0, 3).join(', ')}) + unknown link`;
    }
  }
  if (!settings.textScamRequiresKnownDomain && a.termHits.length >= 3 && a.unknownUrl) {
    return `scam text (${a.termHits.slice(0, 4).join(', ')})`;
  }
  return null;
}

// Decides whether OCR'd image text is a scam. Returns a reason or null.
export function ocrScamVerdict(analysis, suffix = 'in image') {
  const a = analysis;
  const hits = [...new Set([...a.termHits, ...a.phishHits])];
  if (a.knownBad) return `scam link "${a.knownBad}" found ${suffix}`;
  if (hits.length >= CONFIG.ocrScoreThreshold || (hits.length >= 2 && a.unknownUrl)) {
    return `OCR scam signals ${suffix} (${hits.slice(0, 4).join(', ')})`;
  }
  return null;
}
