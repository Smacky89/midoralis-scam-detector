// One command definition → both a `!prefix` command and a `/slash` command.
//
// A definition looks like:
//   {
//     name: 'warn', description: 'Warn a member', category: 'Moderation',
//     level: 'mod' | 'admin' | 'everyone',
//     perm: PermissionFlagsBits.ModerateMembers,   // Discord permission that also grants access
//     aliases: ['w'],                              // prefix-only extra names
//     options: [{ name, type, description, required, choices, min, max, autocomplete }],
//     subcommands: { name: { description, options } },   // instead of options
//     run: async (ctx) => {},
//   }
// Option types: user, channel, role, string, rest (rest of the line), integer,
// duration, boolean, attachment (slash only, text commands read the
// message's attachments instead).
import {
  SlashCommandBuilder, SlashCommandSubcommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags,
  InteractionContextType,
} from 'discord.js';
import { hasPermission } from '../moderation.js';
import { parseDuration } from '../util.js';

export const commands = new Map();   // name -> def
const aliases = new Map();           // alias -> name

export function register(...defs) {
  for (const def of defs) {
    commands.set(def.name, def);
    for (const a of def.aliases || []) aliases.set(a, def.name);
  }
}

export const findCommand = (name) => commands.get(name) || commands.get(aliases.get(name));

// ── permissions ──────────────────────────────────────────────
export function canUse(def, member) {
  if (def.level === 'everyone') return true;
  if (def.level === 'admin') return hasPermission(member, def.perm ?? PermissionFlagsBits.ManageGuild, { modRoleOk: false });
  return hasPermission(member, def.perm);
}

// ── usage strings ────────────────────────────────────────────
function optionUsage(o) {
  const label = o.type === 'rest' ? `${o.name}...` : o.name;
  return o.required ? `<${label}>` : `[${label}]`;
}

export function usage(def, prefix) {
  const textOpts = (opts) => (opts || []).filter((o) => o.type !== 'attachment').map(optionUsage).join(' ');
  if (def.subcommands) {
    return Object.entries(def.subcommands)
      .map(([sub, s]) => `\`${prefix}${def.name} ${sub} ${textOpts(s.options)}\``.replace(/ `$/, '`'))
      .join('\n');
  }
  return `\`${`${prefix}${def.name} ${textOpts(def.options)}`.trim()}\``;
}

// ── text (prefix) argument parsing ───────────────────────────
const ID = /^(\d{17,20})$/;
const USER_MENTION = /^<@!?(\d{17,20})>$/;
const CHANNEL_MENTION = /^<#(\d{17,20})>$/;
const ROLE_MENTION = /^<@&(\d{17,20})>$/;
const BOOLS = { on: true, true: true, yes: true, enable: true, enabled: true, 1: true, off: false, false: false, no: false, disable: false, disabled: false, 0: false };

async function parseToken(o, token, msg) {
  const { guild, client } = msg;
  switch (o.type) {
    case 'user': {
      const id = token.match(USER_MENTION)?.[1] || token.match(ID)?.[1];
      if (!id) return undefined;
      return client.users.fetch(id).catch(() => undefined);
    }
    case 'channel': {
      const id = token.match(CHANNEL_MENTION)?.[1] || token.match(ID)?.[1];
      return id ? guild.channels.fetch(id).catch(() => undefined) : undefined;
    }
    case 'role': {
      const id = token.match(ROLE_MENTION)?.[1] || token.match(ID)?.[1];
      return id ? guild.roles.fetch(id).catch(() => undefined) : undefined;
    }
    case 'integer': {
      if (!/^-?\d+$/.test(token)) return undefined;
      const n = Number(token);
      if ((o.min != null && n < o.min) || (o.max != null && n > o.max)) return undefined;
      return n;
    }
    case 'duration': {
      const d = parseDuration(token);
      return d ?? undefined;
    }
    case 'boolean':
      return BOOLS[token.toLowerCase()];
    case 'string':
      if (o.choices && !o.choices.some((c) => c.value === token.toLowerCase())) return undefined;
      return o.choices ? token.toLowerCase() : token;
    default:
      return undefined;
  }
}

// Returns { opts } or { error }.
export async function parseTextArgs(options, tokens, msg) {
  const opts = {};
  let i = 0;
  for (const o of options || []) {
    if (o.type === 'attachment') continue;
    if (o.type === 'rest') {
      const rest = tokens.slice(i).join(' ').trim();
      if (rest) opts[o.name] = rest;
      i = tokens.length;
    } else if (i < tokens.length) {
      const value = await parseToken(o, tokens[i], msg);
      if (value !== undefined) {
        opts[o.name] = value;
        i++;
      } else if (o.required) {
        return { error: `\`${tokens[i]}\` isn't a valid ${o.name} (${o.type}).` };
      }
    }
    if (o.required && opts[o.name] === undefined) return { error: `Missing **${o.name}**.` };
  }
  return { opts };
}

// ── slash command builders ───────────────────────────────────
function addOption(builder, o) {
  const setup = (opt) => {
    opt.setName(o.name).setDescription(o.description.slice(0, 100)).setRequired(!!o.required);
    if (o.choices) opt.addChoices(...o.choices);
    if (o.min != null && opt.setMinValue) opt.setMinValue(o.min);
    if (o.max != null && opt.setMaxValue) opt.setMaxValue(o.max);
    if (o.autocomplete) opt.setAutocomplete(true);
    return opt;
  };
  switch (o.type) {
    case 'user': return builder.addUserOption(setup);
    case 'channel': return builder.addChannelOption((opt) => setup(opt).addChannelTypes(
      ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice,
    ));
    case 'role': return builder.addRoleOption(setup);
    case 'integer': return builder.addIntegerOption(setup);
    case 'boolean': return builder.addBooleanOption(setup);
    case 'attachment': return builder.addAttachmentOption(setup);
    default: return builder.addStringOption(setup); // string, rest, duration
  }
}

export function buildSlash(def) {
  const b = new SlashCommandBuilder()
    .setName(def.name)
    .setDescription(def.description.slice(0, 100))
    .setContexts(InteractionContextType.Guild);
  if (def.level !== 'everyone') {
    b.setDefaultMemberPermissions(def.level === 'admin' ? (def.perm ?? PermissionFlagsBits.ManageGuild) : (def.perm ?? PermissionFlagsBits.ManageMessages));
  }
  if (def.subcommands) {
    for (const [name, sub] of Object.entries(def.subcommands)) {
      const sb = new SlashCommandSubcommandBuilder().setName(name).setDescription(sub.description.slice(0, 100));
      for (const o of sub.options || []) addOption(sb, o);
      b.addSubcommand(sb);
    }
  } else {
    for (const o of def.options || []) addOption(b, o);
  }
  return b.toJSON();
}

// Reads slash options into the same { name: value } shape text parsing gives.
export function readSlashOptions(options, interaction) {
  const opts = {};
  const o = interaction.options;
  for (const opt of options || []) {
    let v;
    switch (opt.type) {
      case 'user': v = o.getUser(opt.name); break;
      case 'channel': v = o.getChannel(opt.name); break;
      case 'role': v = o.getRole(opt.name); break;
      case 'integer': v = o.getInteger(opt.name); break;
      case 'boolean': v = o.getBoolean(opt.name); break;
      case 'attachment': v = o.getAttachment(opt.name); break;
      case 'duration': {
        const raw = o.getString(opt.name);
        if (raw != null) {
          v = parseDuration(raw);
          if (v == null) return { error: `\`${raw}\` isn't a valid duration. Try 10m, 2h, 1d or 1w.` };
        }
        break;
      }
      default: v = o.getString(opt.name);
    }
    if (v != null) opts[opt.name] = v;
  }
  return { opts };
}

// ── reply helpers ────────────────────────────────────────────
const NO_PINGS = { parse: [], repliedUser: false };

export function textContext(msg, def, opts, sub) {
  return {
    def, sub, opts, isSlash: false,
    guild: msg.guild, member: msg.member, user: msg.author, channel: msg.channel, client: msg.client,
    message: msg,
    attachments: [...msg.attachments.values()],
    async reply(payload) {
      const p = typeof payload === 'string' ? { content: payload } : payload;
      return msg.reply({ allowedMentions: NO_PINGS, ...p }).catch((e) => console.error('reply failed:', e.message));
    },
  };
}

export function slashContext(interaction, def, opts, sub) {
  let replied = false;
  return {
    def, sub, opts, isSlash: true,
    guild: interaction.guild, member: interaction.member, user: interaction.user,
    channel: interaction.channel, client: interaction.client,
    interaction,
    attachments: [],
    async reply(payload) {
      const p = typeof payload === 'string' ? { content: payload } : payload;
      const out = { allowedMentions: NO_PINGS, ...p };
      try {
        if (!replied) {
          replied = true;
          return await interaction.editReply(out);
        }
        return await interaction.followUp({ ...out, flags: MessageFlags.Ephemeral });
      } catch (e) {
        console.error('interaction reply failed:', e.message);
      }
    },
  };
}
