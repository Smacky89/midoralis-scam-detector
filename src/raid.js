// Anti-raid: join-flood detection, raid mode, and the account-age gate.
// Needs the privileged "Server Members" intent (guildMemberAdd events).
import { EmbedBuilder } from 'discord.js';
import { getSettings } from './store.js';
import { sendModLog, COLORS } from './logging.js';
import { applyAutoAction } from './moderation.js';
import { formatDuration } from './util.js';

const joins = new Map();     // guildId -> [timestamps]
const raidUntil = new Map(); // guildId -> timestamp (Infinity = manual, until turned off)

const raidModeUntil = (guildId) => {
  const until = raidUntil.get(guildId) || 0;
  return until > Date.now() ? until : 0;
};

export async function setRaidMode(guild, until, why) {
  const wasOn = !!raidModeUntil(guild.id);
  if (until > Date.now()) raidUntil.set(guild.id, until);
  else raidUntil.delete(guild.id);
  const on = !!raidModeUntil(guild.id);
  if (on === wasOn && until !== Infinity) return;
  const embed = new EmbedBuilder()
    .setColor(on ? COLORS.raid : COLORS.ok)
    .setTitle(on ? '🚨 Raid mode ON' : '✅ Raid mode OFF')
    .setDescription(`${why}${on && until !== Infinity ? `\nEnds automatically in ${formatDuration(until - Date.now())}.` : ''}`)
    .setTimestamp();
  await sendModLog(guild, { embeds: [embed] });
}

export async function onMemberJoin(member) {
  const { guild } = member;
  const s = getSettings(guild.id);
  const now = Date.now();

  // 1. Join-flood detection
  if (s.antiRaid) {
    const list = (joins.get(guild.id) || []).filter((t) => now - t < s.raidWindow);
    list.push(now);
    joins.set(guild.id, list);
    if (list.length >= s.raidJoins && !raidModeUntil(guild.id)) {
      await setRaidMode(guild, now + s.raidModeDuration,
        `${list.length} members joined within ${formatDuration(s.raidWindow)}. New joiners will get: **${s.raidAction}**.`);
    }
  }

  if (s.monitorOnly) return;

  // 2. Raid mode: action everyone joining
  if (raidModeUntil(guild.id)) {
    // Silent: one mod-log post per raider would bury the log during a raid.
    await applyAutoAction(guild, member.user, s.raidAction, 'Joined during raid mode', s.automodTimeout, { silent: true });
    return;
  }

  // 3. Account-age gate
  if (s.minAccountAgeDays > 0) {
    const ageMs = now - member.user.createdTimestamp;
    if (ageMs < s.minAccountAgeDays * 86_400_000) {
      await applyAutoAction(guild, member.user, s.youngAccountAction,
        `Account too new (${formatDuration(ageMs)} old, minimum ${s.minAccountAgeDays}d)`, s.automodTimeout);
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, list] of joins) if (!list.length || now - list[list.length - 1] > 10 * 60_000) joins.delete(id);
}, 60_000).unref();
