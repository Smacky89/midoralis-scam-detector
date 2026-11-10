// Tests for the automod rules and the duration helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capsRatio, countEmojis, isZalgo, findBadWord, runAutomod, recordMessage } from '../src/automod.js';
import { SETTINGS_SCHEMA } from '../src/config.js';
import { parseDuration, formatDuration } from '../src/util.js';

const defaults = () => Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([k, d]) => [k, structuredClone(d.default)]));

let nextId = 1;
function fakeMsg(content, { user = 'u1', channel = 'c1', attachments = [] } = {}) {
  return {
    id: String(nextId++), content, createdTimestamp: Date.now(),
    guild: { id: 'g1' }, author: { id: user }, channel: { id: channel },
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
    mentions: { users: new Map(), roles: new Map() },
  };
}
const ctx = (settings, extra = {}) => ({ settings, member: null, resolveInvite: async () => null, ...extra });

test('durations', () => {
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.equal(parseDuration('15'), 900_000);
  assert.equal(parseDuration('soon'), null);
  assert.equal(parseDuration('10x'), null);
  assert.equal(formatDuration(5_400_000), '1h 30m');
});

test('caps / emoji / zalgo helpers', () => {
  assert.ok(capsRatio('THIS IS ALL SHOUTING RIGHT NOW') >= 90);
  assert.equal(capsRatio('OK'), 0); // too short to judge
  assert.equal(countEmojis('hi 😀😀 <:pog:123456789012345678>'), 3);
  assert.ok(isZalgo('h̸̢̛̛e̶̢̛l̷̨̛l̸̢̛ơ̵̢̧̧̨ ̴̧̢̛w̵̧̨o̴̢̧r̶̨̛l̵̢̛d̸̡̢̛'));
  assert.equal(isZalgo('héllo wörld'), false);
});

test('bad word filter handles leetspeak, spacing and wildcards but not substrings', () => {
  const list = ['badword', 'nasty*', 'two words'];
  assert.equal(findBadWord('you are a badword', list), 'badword');
  assert.equal(findBadWord('you are a b4dw0rd', list), 'badword');
  assert.equal(findBadWord('b a d w o r d', list), 'badword');
  assert.equal(findBadWord('baaaadword', list), null);
  assert.equal(findBadWord('so nastyyy', list), 'nasty*');
  assert.equal(findBadWord('these two words here', list), 'two words');
  assert.equal(findBadWord('notbadwordish', list), null); // no Scunthorpe problem
  assert.equal(findBadWord('anything', []), null);
});

test('duplicate spam across channels is caught with all copies', async () => {
  const s = defaults();
  let v;
  for (const ch of ['c1', 'c2', 'c3']) {
    const m = fakeMsg('check out my new server for free stuff!!', { user: 'dup', channel: ch });
    recordMessage(m);
    v = await runAutomod(m, ctx(s));
  }
  assert.equal(v.rule, 'duplicate');
  assert.equal(v.messages.length, 3);
  assert.equal(v.action, 'timeout');
});

test('message flood is caught', async () => {
  const s = defaults();
  let v = null;
  for (let i = 0; i < s.spamMessages; i++) {
    const m = fakeMsg(`message number ${i} with different text`, { user: 'flood' });
    recordMessage(m);
    v = await runAutomod(m, ctx(s));
  }
  assert.equal(v.rule, 'spam');
});

test('invites to other servers are caught, own server allowed', async () => {
  const s = defaults();
  const m = fakeMsg('join discord.gg/other', { user: 'inv' });
  assert.equal((await runAutomod(m, ctx(s, { resolveInvite: async () => 'otherGuild' }))).rule, 'invites');
  const own = fakeMsg('join discord.gg/ours', { user: 'inv' });
  assert.equal(await runAutomod(own, ctx(s, { resolveInvite: async () => 'g1' })), null);
});

test('brand-new members cannot post links', async () => {
  const s = defaults();
  const m = fakeMsg('hey visit https://example.com', { user: 'newbie' });
  const v = await runAutomod(m, ctx(s, { member: { joinedTimestamp: Date.now() - 60_000 } }));
  assert.equal(v.rule, 'newmember');
  const old = await runAutomod(fakeMsg('hey visit https://example.com', { user: 'oldie' }),
    ctx(s, { member: { joinedTimestamp: Date.now() - 86_400_000 } }));
  assert.equal(old, null);
});

test('edits skip history-based rules', async () => {
  const s = defaults();
  const m = fakeMsg('same text repeated a lot here', { user: 'ed' });
  for (let i = 0; i < 5; i++) recordMessage({ ...m, id: `e${i}` });
  assert.equal(await runAutomod(m, ctx(s, { isEdit: true })), null);
});
