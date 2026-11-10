// Tests for text scam detection: links, lookalike domains, phishing bait, OCR text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/store.js';
import {
  analyzeText, textScamVerdict, ocrScamVerdict, extractLinks, extractInvites,
  brandImpersonation, maskedLinkMismatches, normalize,
} from '../src/detect/text.js';
import { SETTINGS_SCHEMA } from '../src/config.js';

const settings = Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([k, d]) => [k, structuredClone(d.default)]));
const verdict = (text, s = settings, extra = {}) =>
  textScamVerdict(analyzeText(text, { extraAllowed: s.allowedDomains, heuristics: s.phishingHeuristics }), s, extra);

db.scamDomains.add('deezbet.com');
db.feedDomains.add('steamcommunlty-gift.ru');

test('known scam domains are caught, including subdomains and full URLs', () => {
  assert.match(verdict('join deezbet.com now'), /known scam link "deezbet.com"/);
  assert.match(verdict('https://promo.deezbet.com/r/123'), /deezbet.com/);
  assert.match(verdict('check https://steamcommunlty-gift.ru/trade'), /known scam/);
});

test('normal chat and allowed links are not flagged', () => {
  for (const t of [
    'hey how is everyone doing',
    'look at https://github.com/foo/bar and https://youtube.com/watch?v=x',
    'my file is index.js and config.json',
    'I love the discord app, see https://discord.com/channels/1/2',
    'free nitro would be nice lol',          // bait words but no link
    'check out https://example.com',         // unknown link, no bait
  ]) assert.equal(verdict(t), null, t);
});

test('phishing bait + unknown link is caught', () => {
  assert.match(verdict('FREE NITRO for everyone https://nitro-claim.example.xyz'), /phishing/);
  assert.match(verdict('i\'m leaving cs, take my skins https://some-trade.site'), /phishing/);
});

test('lookalike brand domains are caught', () => {
  assert.ok(brandImpersonation('dlscord.com'));
  assert.ok(brandImpersonation('discorcl.gift'));
  assert.ok(brandImpersonation('discord-nitro.ru'));
  assert.ok(brandImpersonation('steamcommunnity.com'));
  assert.ok(brandImpersonation('steamcommunity.com.ru'));
  assert.equal(brandImpersonation('discard.com'), null);
  assert.equal(brandImpersonation('stream.com'), null);
  assert.equal(brandImpersonation('finance.yahoo.com'), null);
  assert.equal(brandImpersonation('discordbotlist.com'), null);
  assert.equal(brandImpersonation('google.co.uk'), null);
  assert.match(verdict('get it here https://dlscord.com/gift/abc'), /lookalike of discord/);
});

test('Unicode homoglyph domains are caught', () => {
  const links = extractLinks('https://dіscord.com/gift'); // Cyrillic і
  assert.equal(links.length, 1);
  assert.ok(links[0].domain.startsWith('xn--'));
  assert.ok(links[0].homoglyph);
  assert.match(verdict('https://dіscord.com/gift'), /look-alike characters/);
});

test('masked markdown links that lie about their target are caught', () => {
  const m = maskedLinkMismatches('[https://discord.com/gift](https://evil.example/x)');
  assert.deepEqual(m, [{ shown: 'discord.com', actual: 'evil.example' }]);
  assert.match(verdict('claim: [discord.com/gift](https://evil.example/x)'), /disguised link/);
  assert.equal(verdict('[docs](https://github.com/x)'), null);
});

test('@everyone + scam words + unknown link is caught', () => {
  assert.match(verdict('@everyone giveaway https://x-drop.example', settings, { everyoneAttempt: true }), /@everyone/);
});

test('aggressive text mode uses scam words + unknown link', () => {
  const s = { ...settings, textScamRequiresKnownDomain: false };
  const t = 'crypto casino deposit bonus https://casino-example.io';
  assert.equal(verdict(t), null);
  assert.match(verdict(t, s), /scam text/);
});

test('zero-width characters do not hide links', () => {
  assert.match(verdict('deez\u200Bbet.com'), /deezbet.com/);
});

test('OCR verdict thresholds', () => {
  const a = analyzeText('USE PROMO CODE for a 100% deposit bonus at our CASINO', { ocr: true });
  assert.ok(ocrScamVerdict(a));
  const b = analyzeText('a nice picture of my cat', { ocr: true });
  assert.equal(ocrScamVerdict(b), null);
});

test('invite extraction', () => {
  assert.deepEqual(extractInvites('join discord.gg/abc123 and https://discord.com/invite/xyz'), ['abc123', 'xyz']);
  assert.deepEqual(extractInvites('nothing here'), []);
});

test('normalize maps confusables', () => {
  assert.equal(normalize('FRΕΕ NІTRO'), 'free nitro');
});
