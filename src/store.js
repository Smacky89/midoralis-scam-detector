// Persistence: small JSON files next to BLOCKLIST_PATH (same volume).
// Writes are atomic (tmp file + rename) and serialised per file, so a crash
// or two overlapping saves can never leave a half-written/corrupt file.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG, SETTINGS_SCHEMA } from './config.js';

export const DATA_DIR = dirname(CONFIG.blocklistFile);
export const FILES = {
  hashes: CONFIG.blocklistFile,
  domains: join(DATA_DIR, 'scam-domains.json'),
  auditLog: join(DATA_DIR, 'audit-log.json'),
  guilds: join(DATA_DIR, 'guilds.json'),
  cases: join(DATA_DIR, 'cases.json'),
  feed: join(DATA_DIR, 'phishing-feed-cache.json'),
};
export const LOG_IMAGES_DIR = join(DATA_DIR, 'log-images');   // thumbnails for !showlog
export const HASH_IMAGES_DIR = join(DATA_DIR, 'hash-images'); // thumbnails for !showblockedimages

export const db = {
  blocklist: [],                                   // [{ hash, addedBy, addedAt, note }]
  scamDomains: new Set(CONFIG.seedScamDomains.map((d) => d.toLowerCase())),
  feedDomains: new Set(),                          // from public phishing feeds (not persisted with learned ones)
  auditLog: [],                                    // [{ id, guildId, authorTag, authorId, channelId, reason, content, timestamp, thumbs }]
  guilds: {},                                      // guildId -> { settings: {}, lockedChannels: [] }
  cases: {},                                       // guildId -> { nextId, list: [] }
};

// ── low-level atomic JSON IO ─────────────────────────────────
const writeChains = new Map();
export function writeJson(file, value) {
  const prev = writeChains.get(file) || Promise.resolve();
  const next = prev.then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, file);
  }).catch((e) => console.error(`save ${file} failed:`, e.message));
  writeChains.set(file, next);
  return next;
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    console.error(`Bad ${file}, starting empty:`, e.message);
    return fallback;
  }
}

// Debounced save so chatty data (audit log, cases) isn't rewritten per event.
const timers = new Map();
function debounced(key, fn, ms = 1500) {
  return () => {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      fn();
    }, ms));
  };
}

export const saveHashes = () => writeJson(FILES.hashes, db.blocklist);
export const saveDomains = () => writeJson(FILES.domains, [...db.scamDomains]);
export const saveGuilds = () => writeJson(FILES.guilds, db.guilds);
export const saveAuditLog = debounced('audit', () => writeJson(FILES.auditLog, db.auditLog));
export const saveCases = debounced('cases', () => writeJson(FILES.cases, db.cases));

export async function flushAll() {
  for (const [key, t] of timers) {
    clearTimeout(t);
    timers.delete(key);
  }
  await Promise.all([
    writeJson(FILES.auditLog, db.auditLog),
    writeJson(FILES.cases, db.cases),
    ...writeChains.values(),
  ]);
}

export async function loadAll() {
  db.blocklist = await readJson(FILES.hashes, []);
  for (const d of await readJson(FILES.domains, [])) db.scamDomains.add(String(d).toLowerCase());
  db.auditLog = await readJson(FILES.auditLog, []);
  db.guilds = await readJson(FILES.guilds, {});
  db.cases = await readJson(FILES.cases, {});
  for (const d of await readJson(FILES.feed, [])) db.feedDomains.add(d);

  console.log(
    `Loaded ${db.blocklist.length} hashes, ${db.scamDomains.size} learned domains, ` +
    `${db.feedDomains.size} feed domains, ${Object.keys(db.guilds).length} server config(s), ` +
    `${db.auditLog.length} audit log entries.`
  );
}

// ── per-guild settings ───────────────────────────────────────
export function guildState(guildId) {
  if (!db.guilds[guildId]) db.guilds[guildId] = { settings: {}, lockedChannels: [] };
  const g = db.guilds[guildId];
  g.settings ??= {};
  g.lockedChannels ??= [];
  return g;
}

// Effective settings = schema defaults overlaid with this server's overrides.
export function getSettings(guildId) {
  const overrides = db.guilds[guildId]?.settings || {};
  const out = {};
  for (const [key, def] of Object.entries(SETTINGS_SCHEMA)) {
    out[key] = key in overrides ? overrides[key] : structuredClone(def.default);
  }
  return out;
}

export async function setSetting(guildId, key, value) {
  const g = guildState(guildId);
  if (value === undefined) delete g.settings[key];
  else g.settings[key] = value;
  await saveGuilds();
}

// ── moderation cases ─────────────────────────────────────────
export function addCase(guildId, data) {
  const bucket = (db.cases[guildId] ??= { nextId: 1, list: [] });
  const entry = { id: bucket.nextId++, createdAt: new Date().toISOString(), ...data };
  bucket.list.push(entry);
  if (bucket.list.length > CONFIG.maxCasesPerGuild) {
    bucket.list.splice(0, bucket.list.length - CONFIG.maxCasesPerGuild);
  }
  saveCases();
  return entry;
}

export const getCase = (guildId, id) => db.cases[guildId]?.list.find((c) => c.id === id) || null;
export const casesFor = (guildId, userId) => (db.cases[guildId]?.list || []).filter((c) => c.userId === userId);

// Warnings that still count toward escalation.
export function activeWarnings(guildId, userId, expiryDays) {
  const cutoff = expiryDays > 0 ? Date.now() - expiryDays * 86_400_000 : 0;
  return casesFor(guildId, userId).filter(
    (c) => c.type === 'warn' && !c.cleared && Date.parse(c.createdAt) >= cutoff
  );
}
