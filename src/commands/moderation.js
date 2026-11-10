// Moderation commands: warn, timeout, kick, ban, purge, lock, cases…
import { EmbedBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { register } from './framework.js';
import { punish, hierarchyError, MAX_TIMEOUT } from '../moderation.js';
import {
  getCase, casesFor, activeWarnings, getSettings, saveCases, guildState, saveGuilds,
} from '../store.js';
import { caseEmbed, COLORS, sendModLog } from '../logging.js';
import { formatDuration, parseDuration, truncate } from '../util.js';
import { setRaidMode } from '../raid.js';

const MOD = 'Moderation';
const user = (description = 'Member') => ({ name: 'user', type: 'user', required: true, description });
const reason = { name: 'reason', type: 'rest', description: 'Reason (shown in the log and DM)' };

// Shared flow for warn/timeout/kick/ban/softban.
async function runPunish(ctx, action, extra = {}) {
  const target = ctx.opts.user;
  const member = await ctx.guild.members.fetch(target.id).catch(() => null);
  const err = hierarchyError(ctx.member, member, action);
  if (err) return ctx.reply(`❌ ${err}`);
  const res = await punish({
    guild: ctx.guild, user: target, moderator: ctx.user, action,
    reason: ctx.opts.reason || '', ...extra,
  });
  if (!res.ok) return ctx.reply(`❌ Couldn't ${action} ${target.tag}: ${res.error}`);
  let text = `✅ **${target.tag}**: ${action}${extra.duration ? ` for ${formatDuration(res.case.duration)}` : ''} (case #${res.case.id}).`;
  if (action === 'warn') {
    const n = activeWarnings(ctx.guild.id, target.id, getSettings(ctx.guild.id).warnExpiryDays).length;
    text += ` They now have **${n}** active warning(s).`;
  }
  return ctx.reply(text);
}

// Locks/unlocks @everyone's ability to talk in a channel, remembering the
// previous overwrite so unlock restores exactly what was there before.
async function lockChannel(channel, reasonText) {
  const everyone = channel.guild.roles.everyone;
  const g = guildState(channel.guild.id);
  if (g.lockedChannels.some((l) => l.channelId === channel.id)) return false;
  const prev = channel.permissionOverwrites.cache.get(everyone.id);
  const prevState = prev?.allow.has(PermissionFlagsBits.SendMessages) ? true
    : prev?.deny.has(PermissionFlagsBits.SendMessages) ? false : null;
  await channel.permissionOverwrites.edit(everyone, {
    SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, AddReactions: false,
  }, { reason: reasonText });
  g.lockedChannels.push({ channelId: channel.id, prev: prevState });
  await saveGuilds();
  return true;
}

async function unlockChannel(channel, reasonText) {
  const everyone = channel.guild.roles.everyone;
  const g = guildState(channel.guild.id);
  const rec = g.lockedChannels.find((l) => l.channelId === channel.id);
  await channel.permissionOverwrites.edit(everyone, {
    SendMessages: rec ? rec.prev : null, SendMessagesInThreads: null, CreatePublicThreads: null, AddReactions: null,
  }, { reason: reasonText });
  g.lockedChannels = g.lockedChannels.filter((l) => l.channelId !== channel.id);
  await saveGuilds();
}

register(
  {
    name: 'warn', category: MOD, level: 'mod', perm: PermissionFlagsBits.ModerateMembers,
    description: 'Warn a member (counts toward automatic escalation).',
    options: [user(), reason],
    run: (ctx) => runPunish(ctx, 'warn'),
  },
  {
    name: 'timeout', aliases: ['mute'], category: MOD, level: 'mod', perm: PermissionFlagsBits.ModerateMembers,
    description: 'Time out a member (max 28 days).',
    options: [user(), { name: 'duration', type: 'duration', required: true, description: 'e.g. 10m, 2h, 1d, 1w' }, reason],
    run: (ctx) => runPunish(ctx, 'timeout', { duration: Math.min(ctx.opts.duration, MAX_TIMEOUT) }),
  },
  {
    name: 'untimeout', aliases: ['unmute'], category: MOD, level: 'mod', perm: PermissionFlagsBits.ModerateMembers,
    description: 'Remove a member\'s timeout.',
    options: [user(), reason],
    run: (ctx) => runPunish(ctx, 'untimeout'),
  },
  {
    name: 'kick', category: MOD, level: 'mod', perm: PermissionFlagsBits.KickMembers,
    description: 'Kick a member.',
    options: [user(), reason],
    run: (ctx) => runPunish(ctx, 'kick'),
  },
  {
    name: 'softban', category: MOD, level: 'mod', perm: PermissionFlagsBits.BanMembers,
    description: 'Kick + delete their last 24h of messages (great for hacked accounts).',
    options: [user(), reason],
    run: (ctx) => runPunish(ctx, 'softban'),
  },
  {
    name: 'ban', category: MOD, level: 'mod', perm: PermissionFlagsBits.BanMembers,
    description: 'Ban a user (works by ID even if they already left).',
    options: [user('User or ID'), reason],
    run: (ctx) => runPunish(ctx, 'ban', { deleteMessageSeconds: 3600 }),
  },
  {
    name: 'unban', category: MOD, level: 'mod', perm: PermissionFlagsBits.BanMembers,
    description: 'Unban a user by ID.',
    options: [user('User ID'), reason],
    async run(ctx) {
      const ban = await ctx.guild.bans.fetch(ctx.opts.user.id).catch(() => null);
      if (!ban) return ctx.reply(`${ctx.opts.user.tag} isn't banned.`);
      return runPunish(ctx, 'unban');
    },
  },
  {
    name: 'note', category: MOD, level: 'mod', perm: PermissionFlagsBits.ModerateMembers,
    description: 'Add a private mod note to a user\'s history.',
    options: [user(), { name: 'text', type: 'rest', required: true, description: 'The note' }],
    async run(ctx) {
      ctx.opts.reason = ctx.opts.text;
      return runPunish(ctx, 'note');
    },
  },
  {
    name: 'warnings', aliases: ['history', 'modlogs', 'cases'], category: MOD, level: 'mod', perm: PermissionFlagsBits.ModerateMembers,
    description: 'Show a user\'s moderation history.',
    options: [user('User')],
    async run(ctx) {
      const u = ctx.opts.user;
      const s = getSettings(ctx.guild.id);
      const all = casesFor(ctx.guild.id, u.id);
      if (!all.length) return ctx.reply(`**${u.tag}** has a clean record.`);
      const active = activeWarnings(ctx.guild.id, u.id, s.warnExpiryDays).length;
      const lines = all.slice(-15).reverse().map((c) =>
        `\`#${c.id}\` **${c.type}**${c.duration ? ` ${formatDuration(c.duration)}` : ''}${c.cleared ? ' ~~cleared~~' : ''}, ` +
        `${truncate(c.reason || 'no reason', 80)} · <t:${Math.floor(Date.parse(c.createdAt) / 1000)}:R>`);
      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setAuthor({ name: `${u.tag} (${u.id})`, iconURL: u.displayAvatarURL() })
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${all.length} case(s) · ${active} active warning(s)${all.length > 15 ? ' · showing latest 15' : ''}` });
      return ctx.reply({ embeds: [embed] });
    },
  },
  {
    name: 'clearwarnings', aliases: ['clearwarns', 'delwarn'], category: MOD, level: 'mod', perm: PermissionFlagsBits.ModerateMembers,
    description: 'Clear all of a user\'s warnings, or just one case.',
    options: [user(), { name: 'case', type: 'integer', min: 1, description: 'Only clear this case number' }],
    async run(ctx) {
      const list = casesFor(ctx.guild.id, ctx.opts.user.id)
        .filter((c) => c.type === 'warn' && !c.cleared && (!ctx.opts.case || c.id === ctx.opts.case));
      list.forEach((c) => { c.cleared = true; });
      saveCases();
      return ctx.reply(list.length ? `Cleared ${list.length} warning(s) for **${ctx.opts.user.tag}**.` : 'No matching active warnings.');
    },
  },
  {
    name: 'case', category: MOD, level: 'mod', perm: PermissionFlagsBits.ModerateMembers,
    description: 'Look up a moderation case.',
    options: [{ name: 'id', type: 'integer', required: true, min: 1, description: 'Case number' }],
    async run(ctx) {
      const c = getCase(ctx.guild.id, ctx.opts.id);
      return ctx.reply(c ? { embeds: [caseEmbed(c)] } : 'No such case.');
    },
  },
  {
    name: 'reason', category: MOD, level: 'mod', perm: PermissionFlagsBits.ModerateMembers,
    description: 'Change the reason on a case.',
    options: [{ name: 'id', type: 'integer', required: true, min: 1, description: 'Case number' },
      { name: 'text', type: 'rest', required: true, description: 'New reason' }],
    async run(ctx) {
      const c = getCase(ctx.guild.id, ctx.opts.id);
      if (!c) return ctx.reply('No such case.');
      c.reason = ctx.opts.text;
      saveCases();
      return ctx.reply({ content: 'Updated.', embeds: [caseEmbed(c)] });
    },
  },
  {
    name: 'purge', aliases: ['clear', 'clean'], category: MOD, level: 'mod', perm: PermissionFlagsBits.ManageMessages,
    description: 'Bulk-delete recent messages (optionally only from one user, or only bots/links).',
    options: [
      { name: 'amount', type: 'integer', required: true, min: 1, max: 500, description: 'How many messages to scan (1-500)' },
      { name: 'user', type: 'user', description: 'Only delete this user\'s messages' },
      { name: 'filter', type: 'string', description: 'bots | links | images', choices: [
        { name: 'bots', value: 'bots' }, { name: 'links', value: 'links' }, { name: 'images', value: 'images' }] },
    ],
    async run(ctx) {
      const { amount, user: target, filter } = ctx.opts;
      const channel = ctx.channel;
      if (!channel.permissionsFor(ctx.guild.members.me).has(PermissionFlagsBits.ManageMessages)) {
        return ctx.reply('I need **Manage Messages** in this channel.');
      }
      if (ctx.message) await ctx.message.delete().catch(() => {});
      const cutoff = Date.now() - 14 * 86_400_000 + 60_000; // Discord can't bulk-delete older than 14 days
      let scanned = 0, deleted = 0;
      let before;
      while (scanned < amount) {
        const batch = await channel.messages.fetch({ limit: Math.min(100, amount - scanned), before }).catch(() => null);
        if (!batch?.size) break;
        scanned += batch.size;
        before = batch.last().id;
        const toDelete = batch.filter((m) => m.createdTimestamp > cutoff && !m.pinned &&
          (!target || m.author.id === target.id) &&
          (filter !== 'bots' || m.author.bot) &&
          (filter !== 'links' || /https?:\/\//i.test(m.content)) &&
          (filter !== 'images' || m.attachments.size > 0));
        if (toDelete.size) deleted += (await channel.bulkDelete(toDelete, true).catch(() => null))?.size || 0;
        if (batch.last().createdTimestamp < cutoff) break;
      }
      await sendModLog(ctx.guild, {
        embeds: [new EmbedBuilder().setColor(COLORS.delete).setTitle('🧹 Purge')
          .setDescription(`${ctx.user.tag} deleted **${deleted}** message(s) in <#${channel.id}>` +
            `${target ? ` from ${target.tag}` : ''}${filter ? ` (${filter})` : ''}.`).setTimestamp()],
      });
      const r = await ctx.reply(`🧹 Deleted ${deleted} message(s).`);
      if (!ctx.isSlash && r) setTimeout(() => r.delete().catch(() => {}), 5000);
    },
  },
  {
    name: 'slowmode', category: MOD, level: 'mod', perm: PermissionFlagsBits.ManageChannels,
    description: 'Set slowmode for a channel (0 or "off" to disable, max 6h).',
    options: [{ name: 'duration', type: 'string', required: true, description: 'e.g. 5s, 30s, 2m, off' },
      { name: 'channel', type: 'channel', description: 'Channel (default: this one)' }],
    async run(ctx) {
      const ch = ctx.opts.channel || ctx.channel;
      const raw = ctx.opts.duration.toLowerCase();
      const ms = ['off', '0', 'none'].includes(raw) ? 0 : /^\d+$/.test(raw) ? Number(raw) * 1000 : parseDuration(raw);
      if (ms == null || ms > 6 * 3_600_000) return ctx.reply('Give a duration between 0 and 6h, e.g. `10s`, `1m`, `off`.');
      await ch.setRateLimitPerUser(Math.round(ms / 1000), `by ${ctx.user.tag}`);
      return ctx.reply(ms ? `🐢 Slowmode in <#${ch.id}> set to ${formatDuration(ms)}.` : `Slowmode off in <#${ch.id}>.`);
    },
  },
  {
    name: 'lock', category: MOD, level: 'mod', perm: PermissionFlagsBits.ManageChannels,
    description: 'Stop @everyone from talking in a channel.',
    options: [{ name: 'channel', type: 'channel', description: 'Channel (default: this one)' }, reason],
    async run(ctx) {
      const ch = ctx.opts.channel || ctx.channel;
      const done = await lockChannel(ch, `Locked by ${ctx.user.tag}: ${ctx.opts.reason || ''}`).catch((e) => e);
      if (done instanceof Error) return ctx.reply(`❌ ${done.message}`);
      if (ch.id !== ctx.channel.id || !ctx.isSlash) {
        await ch.send(`🔒 This channel has been locked.${ctx.opts.reason ? ` Reason: ${ctx.opts.reason}` : ''}`).catch(() => {});
      }
      return ctx.reply(done ? `🔒 Locked <#${ch.id}>.` : `<#${ch.id}> is already locked.`);
    },
  },
  {
    name: 'unlock', category: MOD, level: 'mod', perm: PermissionFlagsBits.ManageChannels,
    description: 'Unlock a channel locked with lock/lockdown.',
    options: [{ name: 'channel', type: 'channel', description: 'Channel (default: this one)' }],
    async run(ctx) {
      const ch = ctx.opts.channel || ctx.channel;
      const res = await unlockChannel(ch, `Unlocked by ${ctx.user.tag}`).catch((e) => e);
      if (res instanceof Error) return ctx.reply(`❌ ${res.message}`);
      return ctx.reply(`🔓 Unlocked <#${ch.id}>.`);
    },
  },
  {
    name: 'lockdown', category: MOD, level: 'admin', perm: PermissionFlagsBits.ManageGuild,
    description: 'Lock (or unlock) every public text channel at once.',
    options: [{ name: 'state', type: 'string', required: true, description: 'on or off',
      choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }] }, reason],
    async run(ctx) {
      const g = guildState(ctx.guild.id);
      const everyone = ctx.guild.roles.everyone;
      if (ctx.opts.state === 'on') {
        let n = 0;
        for (const ch of ctx.guild.channels.cache.values()) {
          if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(ch.type)) continue;
          if (!ch.permissionsFor(everyone).has(PermissionFlagsBits.SendMessages)) continue;
          if (!ch.permissionsFor(ctx.guild.members.me).has(PermissionFlagsBits.ManageRoles)) continue;
          if (await lockChannel(ch, `Lockdown by ${ctx.user.tag}`).catch(() => false)) n++;
        }
        await sendModLog(ctx.guild, { embeds: [new EmbedBuilder().setColor(COLORS.raid).setTitle('🔒 Server lockdown ON')
          .setDescription(`${ctx.user.tag} locked ${n} channel(s).${ctx.opts.reason ? `\nReason: ${ctx.opts.reason}` : ''}`).setTimestamp()] });
        return ctx.reply(`🔒 Lockdown on: locked ${n} channel(s). Use \`lockdown off\` to restore them.`);
      }
      const locked = [...g.lockedChannels];
      let n = 0;
      for (const l of locked) {
        const ch = ctx.guild.channels.cache.get(l.channelId);
        if (!ch) { g.lockedChannels = g.lockedChannels.filter((x) => x.channelId !== l.channelId); continue; }
        if (await unlockChannel(ch, `Lockdown lifted by ${ctx.user.tag}`).then(() => true, () => false)) n++;
      }
      await saveGuilds();
      await sendModLog(ctx.guild, { embeds: [new EmbedBuilder().setColor(COLORS.ok).setTitle('🔓 Server lockdown OFF')
        .setDescription(`${ctx.user.tag} unlocked ${n} channel(s).`).setTimestamp()] });
      return ctx.reply(`🔓 Lockdown off: restored ${n} channel(s).`);
    },
  },
  {
    name: 'raidmode', category: MOD, level: 'admin', perm: PermissionFlagsBits.ManageGuild,
    description: 'Manually turn raid mode on/off (new joiners get the raidAction).',
    options: [{ name: 'state', type: 'string', required: true, description: 'on or off',
      choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }] }],
    async run(ctx) {
      const on = ctx.opts.state === 'on';
      await setRaidMode(ctx.guild, on ? Infinity : 0, `${on ? 'enabled' : 'disabled'} by ${ctx.user.tag}`);
      const s = getSettings(ctx.guild.id);
      const verb = { timeout: 'timed out', kick: 'kicked', ban: 'banned', softban: 'softbanned' }[s.raidAction] || s.raidAction;
      return ctx.reply(on
        ? `🚨 Raid mode ON: everyone who joins will be **${verb}** until you run \`raidmode off\`.`
        : '✅ Raid mode off.');
    },
  },
);
