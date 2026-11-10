// Carrying out punishments: warn / timeout / kick / softban / ban (+ undo),
// recording cases, DMing the user, posting to the mod log, and automatic
// escalation when warnings pile up.
import { PermissionFlagsBits } from 'discord.js';
import { addCase, activeWarnings, getSettings } from './store.js';
import { sendModLog, caseEmbed, actionVerb } from './logging.js';
import { parseDuration, formatDuration } from './util.js';

export const MAX_TIMEOUT = 28 * 86_400_000;

// Is `member` allowed to run a command needing `perm`? Server admins always
// are; configured mod roles count for every moderation-level command.
export function hasPermission(member, perm, { modRoleOk = true } = {}) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (perm && member.permissions.has(perm)) return true;
  if (modRoleOk) {
    const { modRoles } = getSettings(member.guild.id);
    if (modRoles.some((r) => member.roles.cache.has(r))) return true;
  }
  return false;
}

export function isStaff(member) {
  if (!member) return false;
  return hasPermission(member, PermissionFlagsBits.ManageMessages) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers);
}

// Returns an error string if `moderator` may not act on `target`, else null.
export function hierarchyError(moderator, target, action) {
  if (!target) return null; // user not in server (e.g. ban by ID), nothing to compare
  const guild = target.guild;
  if (target.id === guild.ownerId) return 'You can\'t do that to the server owner.';
  if (target.id === moderator.id && action !== 'note') return 'You can\'t do that to yourself.';
  if (target.id === guild.client.user.id) return 'Nice try.';
  if (moderator.id !== guild.ownerId &&
      target.roles.highest.position >= moderator.roles.highest.position) {
    return `${target.user.tag} has a role equal to or higher than yours.`;
  }
  const me = guild.members.me;
  if (action === 'timeout' && !target.moderatable) return `I can't time out ${target.user.tag} because their role is above mine or they're an admin.`;
  if (action === 'kick' && !target.kickable) return `I can't kick ${target.user.tag} because their role is above mine.`;
  if ((action === 'ban' || action === 'softban') && !target.bannable) return `I can't ban ${target.user.tag} because their role is above mine.`;
  if (action === 'timeout' && !me.permissions.has(PermissionFlagsBits.ModerateMembers)) return 'I need the **Timeout Members** permission.';
  if (action === 'kick' && !me.permissions.has(PermissionFlagsBits.KickMembers)) return 'I need the **Kick Members** permission.';
  if ((action === 'ban' || action === 'softban') && !me.permissions.has(PermissionFlagsBits.BanMembers)) return 'I need the **Ban Members** permission.';
  return null;
}

async function dmUser(user, guild, type, reason, duration) {
  const verb = actionVerb(type);
  const lines = [
    `You were **${verb}** in **${guild.name}**${duration ? ` for **${formatDuration(duration)}**` : ''}.`,
    `Reason: ${reason || 'No reason given'}`,
  ];
  await user.send(lines.join('\n')).catch(() => {});
}

// Parses an escalation step like "timeout 1h", "kick", "ban".
export function parseStep(step) {
  const [action, dur] = String(step).trim().split(/\s+/);
  if (!['warn', 'timeout', 'kick', 'softban', 'ban'].includes(action)) return null;
  const duration = action === 'timeout' ? Math.min(parseDuration(dur || '1h') || 3_600_000, MAX_TIMEOUT) : null;
  return { action, duration };
}

/**
 * Apply a punishment.
 * @param {object} o
 * @param {import('discord.js').Guild} o.guild
 * @param {import('discord.js').User} o.user          the target
 * @param {'warn'|'timeout'|'untimeout'|'kick'|'softban'|'ban'|'unban'|'note'} o.action
 * @param {import('discord.js').User} o.moderator     who did it (the bot for automatic actions)
 * @param {string} [o.reason]
 * @param {number} [o.duration]                       ms, for timeouts
 * @param {boolean} [o.auto]                          triggered by automod / scam / escalation
 * @param {number} [o.deleteMessageSeconds]           for bans
 * @param {boolean} [o.silent]                        don't post the case to the mod log (caller logs it)
 * @returns {Promise<{ ok: boolean, error?: string, case?: object }>}
 */
export async function punish(o) {
  const { guild, user, action, moderator, reason = '', auto = false } = o;
  const settings = getSettings(guild.id);
  const member = await guild.members.fetch(user.id).catch(() => null);
  let duration = o.duration ?? null;

  const needsMember = ['timeout', 'untimeout', 'kick'].includes(action);
  if (needsMember && !member) return { ok: false, error: `${user.tag} isn't in this server.` };
  if (auto && member && action !== 'note') {
    // For automatic actions the bot is the moderator, so this checks the
    // bot's own role position/permissions before anyone gets DM'd.
    const err = hierarchyError(guild.members.me, member, action);
    if (err) return { ok: false, error: err };
  }

  const fullReason = `${reason || 'No reason given'}${auto ? '' : ` (by ${moderator.tag})`}`;
  const dmFirst = settings.dmOnAction && ['warn', 'timeout', 'kick', 'softban', 'ban'].includes(action);
  // DM before kicking/banning, otherwise the bot can't reach them any more.
  if (dmFirst) await dmUser(user, guild, action, reason, duration);

  try {
    switch (action) {
      case 'warn':
      case 'note':
        break;
      case 'timeout':
        duration = Math.min(duration || 3_600_000, MAX_TIMEOUT);
        await member.timeout(duration, fullReason);
        break;
      case 'untimeout':
        await member.timeout(null, fullReason);
        break;
      case 'kick':
        await member.kick(fullReason);
        break;
      case 'ban':
        await guild.members.ban(user.id, { reason: fullReason, deleteMessageSeconds: o.deleteMessageSeconds ?? 0 });
        break;
      case 'softban':
        // Ban + immediate unban = kick that also wipes their last day of messages.
        await guild.members.ban(user.id, { reason: fullReason, deleteMessageSeconds: 86_400 });
        await guild.members.unban(user.id, 'softban: immediate unban');
        break;
      case 'unban':
        await guild.members.unban(user.id, fullReason);
        break;
      default:
        return { ok: false, error: `unknown action ${action}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const c = addCase(guild.id, {
    type: action,
    userId: user.id,
    userTag: user.tag,
    modId: auto ? null : moderator.id,
    modTag: auto ? `${moderator.tag} (auto)` : moderator.tag,
    reason,
    duration: action === 'timeout' ? duration : undefined,
    auto: auto || undefined,
  });
  if (!o.silent) await sendModLog(guild, { embeds: [caseEmbed(c)] });

  if (action === 'warn') await escalate(guild, user);
  return { ok: true, case: c };
}

// When a user reaches exactly N active warnings and the server has an
// escalation step for N, apply it.
async function escalate(guild, user) {
  const settings = getSettings(guild.id);
  const count = activeWarnings(guild.id, user.id, settings.warnExpiryDays).length;
  const step = parseStep(settings.escalation?.[count] || '');
  if (!step || step.action === 'warn') return;
  await punish({
    guild, user, moderator: guild.client.user, auto: true,
    action: step.action, duration: step.duration,
    reason: `Reached ${count} warnings`,
  });
}

// Used by automod/scam handling: turns a configured action ('delete',
// 'warn', 'timeout', …) into a punishment. 'delete' means no punishment.
export async function applyAutoAction(guild, user, action, reason, timeoutMs, { silent = false } = {}) {
  if (!action || action === 'delete') return null;
  return punish({
    guild, user, action, reason, auto: true, silent,
    moderator: guild.client.user,
    duration: action === 'timeout' ? timeoutMs : undefined,
  });
}

export function describeAction(action, timeoutMs) {
  if (action === 'timeout') return `timeout ${formatDuration(timeoutMs)}`;
  return action;
}
