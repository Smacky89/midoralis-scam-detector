// `config` (per-server settings) + general commands: help, userinfo, report, ping.
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { register, commands, canUse, usage } from './framework.js';
import { SETTINGS_SCHEMA, ACTIONS, CREDIT } from '../config.js';
import { getSettings, setSetting, activeWarnings, casesFor, db } from '../store.js';
import { parseDuration, formatDuration, truncate } from '../util.js';
import { parseStep } from '../moderation.js';
import { sendModLog, quickActionRow, COLORS } from '../logging.js';

// ── value parsing / display per setting type ─────────────────
const BOOLS = { on: true, true: true, yes: true, enable: true, 1: true, off: false, false: false, no: false, disable: false, 0: false };
const idOf = (s) => s.match(/(\d{17,20})/)?.[1];
const splitList = (s) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

function parseValue(key, raw, guild) {
  const def = SETTINGS_SCHEMA[key];
  const v = raw.trim();
  switch (def.type) {
    case 'bool':
      if (!(v.toLowerCase() in BOOLS)) return { error: 'Use on/off.' };
      return { value: BOOLS[v.toLowerCase()] };
    case 'int': {
      const n = Number(v);
      if (!Number.isInteger(n)) return { error: 'Give a whole number.' };
      if (n < def.min || n > def.max) return { error: `Must be between ${def.min} and ${def.max}.` };
      return { value: n };
    }
    case 'duration': {
      const ms = parseDuration(v);
      if (!ms) return { error: 'Give a duration like 30s, 10m, 2h, 1d.' };
      return { value: ms };
    }
    case 'string':
      if (!v || v.length > 5) return { error: 'Must be 1-5 characters.' };
      return { value: v };
    case 'action':
      if (!ACTIONS.includes(v.toLowerCase())) return { error: `Must be one of: ${ACTIONS.join(', ')}.` };
      return { value: v.toLowerCase() };
    case 'channel': {
      if (['none', 'off', 'null', 'disable'].includes(v.toLowerCase())) return { value: null };
      const id = idOf(v);
      if (!id || !guild.channels.cache.has(id)) return { error: 'Mention a channel, e.g. #mod-log (or "none").' };
      return { value: id };
    }
    case 'channels':
    case 'roles': {
      if (['none', 'clear'].includes(v.toLowerCase())) return { value: [] };
      const ids = splitList(v).map(idOf);
      const cache = def.type === 'roles' ? guild.roles.cache : guild.channels.cache;
      if (!ids.length || ids.some((id) => !id || !cache.has(id))) {
        return { error: `Mention one or more ${def.type === 'roles' ? 'roles' : 'channels'}.` };
      }
      return { value: [...new Set(ids)] };
    }
    case 'strings':
      if (['none', 'clear'].includes(v.toLowerCase())) return { value: [] };
      return { value: [...new Set(splitList(v).map((x) => x.toLowerCase()))] };
    case 'escalation': {
      if (['none', 'off', 'clear'].includes(v.toLowerCase())) return { value: {} };
      const out = {};
      for (const part of v.split(',')) {
        const m = part.trim().match(/^(\d+)\s*[=:]\s*(.+)$/);
        if (!m || !parseStep(m[2])) return { error: 'Format: `3=timeout 1h, 5=kick, 8=ban`.' };
        out[m[1]] = m[2].trim().toLowerCase();
      }
      return { value: out };
    }
    default:
      return { error: 'Unsupported setting.' };
  }
}

function displayValue(key, value) {
  const def = SETTINGS_SCHEMA[key];
  if (value == null || (Array.isArray(value) && !value.length)) return '-';
  switch (def.type) {
    case 'bool': return value ? 'on' : 'off';
    case 'duration': return formatDuration(value);
    case 'channel': return `<#${value}>`;
    case 'channels': return value.map((id) => `<#${id}>`).join(' ');
    case 'roles': return value.map((id) => `<@&${id}>`).join(' ');
    case 'strings': return value.map((w) => `\`${w}\``).join(', ');
    case 'escalation': {
      const entries = Object.entries(value);
      return entries.length ? entries.map(([n, step]) => `${n} → ${step}`).join(', ') : '-';
    }
    default: return `\`${value}\``;
  }
}

const GROUPS = [
  ['General', ['prefix', 'modRoles', 'logChannel', 'eventLogChannel', 'dmOnAction', 'monitorOnly']],
  ['Scam detection', ['scamDetection', 'scamAction', 'scamTimeout', 'scamPurgeRecent', 'scamDmUser', 'phishingHeuristics', 'textScamRequiresKnownDomain', 'allowedDomains']],
  ['AutoMod', ['automod', 'automodAction', 'automodTimeout', 'exemptRoles', 'exemptChannels', 'antiSpam', 'spamMessages', 'spamWindow',
    'antiDuplicate', 'duplicateCount', 'duplicateWindow', 'duplicateAction', 'antiMassMention', 'maxMentions', 'antiInvites', 'antiLinks',
    'newMemberLinkMinutes', 'antiCaps', 'capsPercent', 'antiEmojiSpam', 'maxEmojis', 'antiWallText', 'maxLines', 'antiZalgo', 'badWords', 'badWordsAction']],
  ['Warnings', ['warnExpiryDays', 'escalation']],
  ['Anti-raid', ['antiRaid', 'raidJoins', 'raidWindow', 'raidModeDuration', 'raidAction', 'minAccountAgeDays', 'youngAccountAction']],
];

const keyOpt = { name: 'key', type: 'string', required: true, description: 'Setting name', autocomplete: true };
const resolveKey = (k) => Object.keys(SETTINGS_SCHEMA).find((x) => x.toLowerCase() === k.toLowerCase());
const LIST_TYPES = ['roles', 'channels', 'strings'];

register(
  {
    name: 'config', aliases: ['settings'], category: 'Setup', level: 'admin', perm: PermissionFlagsBits.ManageGuild,
    description: 'View or change this server\'s settings.',
    subcommands: {
      view: { description: 'Show all settings, or explain one.', options: [{ ...keyOpt, required: false }] },
      set: { description: 'Change a setting.', options: [keyOpt, { name: 'value', type: 'rest', required: true, description: 'New value' }] },
      add: { description: 'Add to a list setting (badWords, allowedDomains, modRoles, exemptRoles…).', options: [keyOpt, { name: 'value', type: 'rest', required: true, description: 'Value(s) to add' }] },
      remove: { description: 'Remove from a list setting.', options: [keyOpt, { name: 'value', type: 'rest', required: true, description: 'Value(s) to remove' }] },
      reset: { description: 'Put a setting back to its default.', options: [keyOpt] },
    },
    autocomplete: (focused) => Object.keys(SETTINGS_SCHEMA).filter((k) => k.toLowerCase().includes(focused.toLowerCase())),
    async run(ctx) {
      const sub = ctx.sub || 'view';
      const s = getSettings(ctx.guild.id);
      const key = ctx.opts.key && resolveKey(ctx.opts.key);
      if (ctx.opts.key && !key) return ctx.reply(`Unknown setting \`${ctx.opts.key}\`. Run \`config view\` to see them all.`);

      if (sub === 'view') {
        if (key) {
          const def = SETTINGS_SCHEMA[key];
          return ctx.reply(`**${key}** = ${displayValue(key, s[key])}\n${def.help}\nDefault: ${displayValue(key, def.default)} · type: ${def.type}`);
        }
        const embed = new EmbedBuilder().setColor(COLORS.info).setTitle(`⚙️ Settings for ${ctx.guild.name}`)
          .setDescription('Change with `config set <key> <value>` · lists: `config add|remove <key> <value>` · `config view <key>` explains one.');
        for (const [title, keys] of GROUPS) {
          embed.addFields({ name: title, value: truncate(keys.map((k) => `\`${k}\`: ${displayValue(k, s[k])}`).join('\n'), 1024) });
        }
        return ctx.reply({ embeds: [embed] });
      }

      const def = SETTINGS_SCHEMA[key];
      if (sub === 'reset') {
        await setSetting(ctx.guild.id, key, undefined);
        return ctx.reply(`**${key}** reset to ${displayValue(key, def.default)}.`);
      }
      if ((sub === 'add' || sub === 'remove') && !LIST_TYPES.includes(def.type)) {
        return ctx.reply(`\`${key}\` isn't a list, use \`config set ${key} <value>\`.`);
      }
      const parsed = parseValue(key, ctx.opts.value, ctx.guild);
      if (parsed.error) return ctx.reply(`❌ ${parsed.error}`);

      let value = parsed.value;
      if (sub === 'add') value = [...new Set([...s[key], ...parsed.value])];
      if (sub === 'remove') value = s[key].filter((x) => !parsed.value.includes(x));
      await setSetting(ctx.guild.id, key, value);
      await sendModLog(ctx.guild, { embeds: [new EmbedBuilder().setColor(COLORS.info).setTitle('⚙️ Setting changed')
        .setDescription(`${ctx.user.tag} set **${key}** → ${key === 'badWords' ? `(${value.length} words)` : displayValue(key, value)}`).setTimestamp()] });
      return ctx.reply(`✅ **${key}** = ${key === 'badWords' ? `${value.length} word(s)` : displayValue(key, value)}`);
    },
  },
  {
    name: 'help', category: 'General', level: 'everyone',
    description: 'List commands, or show how to use one.',
    options: [{ name: 'command', type: 'string', description: 'Command name' }],
    async run(ctx) {
      const prefix = getSettings(ctx.guild.id).prefix;
      if (ctx.opts.command) {
        const def = commands.get(ctx.opts.command.toLowerCase().replace(/^[!/]/, ''));
        if (!def) return ctx.reply('No such command.');
        return ctx.reply(`**${def.name}**: ${def.description}\n${usage(def, prefix)}` +
          `${def.aliases?.length ? `\nAliases: ${def.aliases.join(', ')}` : ''}`);
      }
      const byCat = new Map();
      for (const def of commands.values()) {
        if (!canUse(def, ctx.member)) continue;
        if (!byCat.has(def.category)) byCat.set(def.category, []);
        byCat.get(def.category).push(`\`${def.name}\``);
      }
      const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('🛡️ Midoralis Scam Detector: commands')
        .setDescription(`Use \`${prefix}command\` or \`/command\`. \`${prefix}help <command>\` for details.`)
        .setFooter({ text: CREDIT });
      for (const [cat, list] of byCat) embed.addFields({ name: cat, value: list.join(' ') });
      return ctx.reply({ embeds: [embed] });
    },
  },
  {
    name: 'userinfo', aliases: ['whois'], category: 'Moderation', level: 'mod', perm: PermissionFlagsBits.ModerateMembers,
    description: 'Account age, join date and moderation summary for a user.',
    options: [{ name: 'user', type: 'user', required: true, description: 'User' }],
    async run(ctx) {
      const u = ctx.opts.user;
      const member = await ctx.guild.members.fetch(u.id).catch(() => null);
      const s = getSettings(ctx.guild.id);
      const cases = casesFor(ctx.guild.id, u.id);
      const ts = (ms) => `<t:${Math.floor(ms / 1000)}:F> (<t:${Math.floor(ms / 1000)}:R>)`;
      const embed = new EmbedBuilder().setColor(COLORS.info)
        .setAuthor({ name: `${u.tag} (${u.id})`, iconURL: u.displayAvatarURL() })
        .setThumbnail(u.displayAvatarURL())
        .addFields(
          { name: 'Account created', value: ts(u.createdTimestamp) },
          { name: 'Joined server', value: member?.joinedTimestamp ? ts(member.joinedTimestamp) : 'not in server' },
          { name: 'Warnings (active)', value: `${activeWarnings(ctx.guild.id, u.id, s.warnExpiryDays).length}`, inline: true },
          { name: 'Total cases', value: `${cases.length}`, inline: true },
          { name: 'Scam removals', value: `${db.auditLog.filter((e) => e.guildId === ctx.guild.id && e.authorId === u.id).length}`, inline: true },
        );
      if (member?.communicationDisabledUntilTimestamp > Date.now()) {
        embed.addFields({ name: 'Timed out until', value: ts(member.communicationDisabledUntilTimestamp) });
      }
      if (member) embed.addFields({ name: 'Roles', value: truncate(member.roles.cache.filter((r) => r.id !== ctx.guild.id).map((r) => `<@&${r.id}>`).join(' ') || '-', 1024) });
      return ctx.reply({ embeds: [embed] });
    },
  },
  {
    name: 'report', category: 'General', level: 'everyone',
    description: 'Report a message to the mods (reply to it with !report [reason]).',
    options: [{ name: 'reason', type: 'rest', description: 'What\'s wrong with it?' }],
    async run(ctx) {
      if (ctx.isSlash) return ctx.reply('Right-click (or long-press) the message → **Apps → Report to mods**.');
      const refId = ctx.message.reference?.messageId;
      await ctx.message.delete().catch(() => {});
      if (!refId) return ctx.user.send('To report a message, **reply** to it with `!report [reason]`.').catch(() => {});
      const target = await ctx.channel.messages.fetch(refId).catch(() => null);
      if (!target) return;
      const ok = await reportMessage(target, ctx.user, ctx.opts.reason);
      await ctx.user.send(ok ? `Thanks, your report was sent to the ${ctx.guild.name} mods.`
        : `Sorry, ${ctx.guild.name} hasn't set up a mod log, so reports can't be delivered.`).catch(() => {});
    },
  },
  {
    name: 'ping', category: 'General', level: 'everyone',
    description: 'Check that the bot is alive.',
    async run(ctx) {
      const up = formatDuration(ctx.client.uptime);
      return ctx.reply(`🏓 Pong, ${Math.round(ctx.client.ws.ping)}ms, up ${up}, in ${ctx.client.guilds.cache.size} server(s).`);
    },
  },
);

export async function reportMessage(target, reporter, reason) {
  const embed = new EmbedBuilder().setColor(COLORS.warn).setTitle('📣 Message reported')
    .addFields(
      { name: 'Reported by', value: `<@${reporter.id}> \`${reporter.tag}\``, inline: true },
      { name: 'Author', value: `<@${target.author.id}> \`${target.author.tag}\``, inline: true },
      { name: 'Channel', value: `<#${target.channel.id}> · [jump](${target.url})`, inline: true },
    )
    .setTimestamp();
  if (reason) embed.addFields({ name: 'Reason', value: truncate(reason, 1000) });
  if (target.content) embed.setDescription(truncate(target.content, 2000));
  const img = target.attachments.find((a) => a.contentType?.startsWith('image/'));
  if (img) embed.setImage(img.url);
  const sent = await sendModLog(target.guild, { embeds: [embed], components: [quickActionRow(target.author.id)] });
  return !!sent;
}
