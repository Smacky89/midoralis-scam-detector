// Discord event wiring: messages, edits, deletes, joins/leaves, bans.
import { EmbedBuilder, AuditLogEvent } from 'discord.js';
import { getSettings } from './store.js';
import { findCommand, canUse, parseTextArgs, textContext, usage } from './commands/framework.js';
import { isStaff } from './moderation.js';
import { recordMessage, runAutomod } from './automod.js';
import { scanForScam, handleScam, handleViolation, wasHandled } from './scanner.js';
import { onMemberJoin } from './raid.js';
import { onInteraction } from './interactions.js';
import { sendEventLog, COLORS } from './logging.js';
import { truncate, formatDuration } from './util.js';

// ── invite lookups (cached) ──────────────────────────────────
const inviteCache = new Map(); // code -> { guildId, at }
async function resolveInvite(client, code) {
  const hit = inviteCache.get(code);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.guildId;
  const invite = await client.fetchInvite(code).catch(() => null);
  const guildId = invite?.guild?.id ?? null;
  inviteCache.set(code, { guildId, at: Date.now() });
  if (inviteCache.size > 5000) inviteCache.delete(inviteCache.keys().next().value);
  return guildId;
}

function isExempt(msg, s) {
  if (isStaff(msg.member)) return true;
  if (s.exemptRoles.some((r) => msg.member?.roles.cache.has(r))) return true;
  const ids = [msg.channel.id, msg.channel.parentId, msg.channel.parent?.parentId].filter(Boolean);
  return ids.some((id) => s.exemptChannels.includes(id));
}

// Returns true if the message was a command we handled.
async function tryCommand(msg, s) {
  const mention = new RegExp(`^<@!?${msg.client.user.id}>\\s*`);
  let body = null;
  if (msg.content.startsWith(s.prefix)) body = msg.content.slice(s.prefix.length);
  else if (mention.test(msg.content)) body = msg.content.replace(mention, '');
  if (body == null) return false;

  const tokens = body.trim().split(/\s+/).filter(Boolean);
  const def = findCommand((tokens.shift() || '').toLowerCase());
  // Unknown command, or not allowed: treat it as a normal message so it
  // still gets scanned.
  if (!def || !canUse(def, msg.member)) return false;

  let sub = null;
  let optionDefs = def.options;
  if (def.subcommands) {
    sub = (tokens[0] || '').toLowerCase();
    if (def.subcommands[sub]) tokens.shift();
    else sub = Object.keys(def.subcommands)[0];
    optionDefs = def.subcommands[sub].options;
  }
  const { opts, error } = await parseTextArgs(optionDefs, tokens, msg);
  const ctx = textContext(msg, def, opts || {}, sub);
  if (error) {
    await ctx.reply(`❌ ${error}\nUsage: ${usage(def, s.prefix)}`);
    return true;
  }
  try {
    await def.run(ctx);
  } catch (e) {
    console.error(`${s.prefix}${def.name} failed:`, e);
    await ctx.reply(`❌ Something went wrong: ${e.message}`);
  }
  return true;
}

async function onMessage(msg) {
  if (!msg.guild || msg.author.bot || msg.webhookId || msg.system) return;
  const s = getSettings(msg.guild.id);

  if (await tryCommand(msg, s)) return;

  recordMessage(msg);

  // 1. Scams (everyone, including staff, because hacked mod accounts happen too)
  if (s.scamDetection) {
    const result = await scanForScam(msg, s);
    if (result) return handleScam(msg, result, s);
  }

  // 2. AutoMod
  if (s.automod && !isExempt(msg, s)) {
    const v = await runAutomod(msg, { settings: s, member: msg.member, resolveInvite: (c) => resolveInvite(msg.client, c) });
    if (v) return handleViolation(msg, v, s);
  }
}

async function onMessageUpdate(oldMsg, newMsg) {
  if (!newMsg.guild) return;
  if (newMsg.partial) newMsg = await newMsg.fetch().catch(() => null);
  if (!newMsg || newMsg.author.bot || newMsg.webhookId || wasHandled(newMsg.id)) return;
  const s = getSettings(newMsg.guild.id);

  const contentChanged = !oldMsg.partial && oldMsg.content !== newMsg.content;
  const embedsAdded = (newMsg.embeds?.length || 0) > (oldMsg.embeds?.length || 0);

  if (contentChanged && s.eventLogChannel) {
    await sendEventLog(newMsg.guild, {
      embeds: [new EmbedBuilder().setColor(COLORS.edit).setTitle('✏️ Message edited')
        .setDescription(`<@${newMsg.author.id}> in <#${newMsg.channel.id}> · [jump](${newMsg.url})`)
        .addFields(
          { name: 'Before', value: truncate(oldMsg.content || '-', 1024) },
          { name: 'After', value: truncate(newMsg.content || '-', 1024) },
        ).setTimestamp()],
      allowedMentions: { parse: [] },
    });
  }

  // Scammers post something innocent, then edit the link in.
  if (s.scamDetection && (contentChanged || oldMsg.partial || embedsAdded)) {
    const result = await scanForScam(newMsg, s, {
      text: contentChanged || oldMsg.partial, attachments: false, embeds: embedsAdded,
    });
    if (result) return handleScam(newMsg, result, s);
  }
  if (contentChanged && s.automod && !isExempt(newMsg, s)) {
    const v = await runAutomod(newMsg, { settings: s, member: newMsg.member, isEdit: true, resolveInvite: (c) => resolveInvite(newMsg.client, c) });
    if (v) return handleViolation(newMsg, v, s);
  }
}

async function onMessageDelete(msg) {
  if (!msg.guild || wasHandled(msg.id)) return;
  const s = getSettings(msg.guild.id);
  if (!s.eventLogChannel || msg.author?.bot) return;
  const embed = new EmbedBuilder().setColor(COLORS.delete).setTitle('🗑️ Message deleted')
    .setDescription(msg.partial
      ? `A message in <#${msg.channel.id}> was deleted (it was sent before the bot started, so its content is unknown).`
      : `<@${msg.author.id}> \`${msg.author.tag}\` in <#${msg.channel.id}>`)
    .setTimestamp();
  if (!msg.partial && msg.content) embed.addFields({ name: 'Content', value: truncate(msg.content, 1024) });
  if (!msg.partial && msg.attachments.size) {
    embed.addFields({ name: 'Attachments', value: truncate(msg.attachments.map((a) => a.name).join(', '), 1024) });
  }
  await sendEventLog(msg.guild, { embeds: [embed], allowedMentions: { parse: [] } });
}

async function onMemberAdd(member) {
  await onMemberJoin(member).catch((e) => console.error('join handling failed:', e.message));
  const s = getSettings(member.guild.id);
  if (!s.eventLogChannel) return;
  const age = Date.now() - member.user.createdTimestamp;
  const embed = new EmbedBuilder().setColor(COLORS.join).setTitle('📥 Member joined')
    .setDescription(`<@${member.id}> \`${member.user.tag}\` (${member.id})`)
    .addFields({ name: 'Account age', value: `${formatDuration(age)}${age < 7 * 86_400_000 ? ' ⚠️ new account' : ''}` })
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();
  await sendEventLog(member.guild, { embeds: [embed], allowedMentions: { parse: [] } });
}

async function onMemberRemove(member) {
  const s = getSettings(member.guild.id);
  if (!s.eventLogChannel) return;
  const roles = member.roles?.cache?.filter((r) => r.id !== member.guild.id).map((r) => `<@&${r.id}>`).join(' ');
  const embed = new EmbedBuilder().setColor(COLORS.leave).setTitle('📤 Member left')
    .setDescription(`<@${member.id}> \`${member.user?.tag ?? member.id}\``)
    .setTimestamp();
  if (roles) embed.addFields({ name: 'Roles', value: truncate(roles, 1024) });
  await sendEventLog(member.guild, { embeds: [embed], allowedMentions: { parse: [] } });
}

// Bans done outside the bot (Discord UI, other bots) still show in the event log.
async function onBanAdd(ban) {
  const s = getSettings(ban.guild.id);
  if (!s.eventLogChannel) return;
  const logs = await ban.guild.fetchAuditLogs({ type: AuditLogEvent.MemberBanAdd, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => e.target?.id === ban.user.id);
  if (entry?.executor?.id === ban.client.user.id) return; // ours, already in the mod log
  await sendEventLog(ban.guild, {
    embeds: [new EmbedBuilder().setColor(COLORS.ban).setTitle('🔨 Member banned')
      .setDescription(`<@${ban.user.id}> \`${ban.user.tag}\`${entry?.executor ? ` by ${entry.executor.tag}` : ''}`)
      .addFields({ name: 'Reason', value: truncate(entry?.reason || ban.reason || 'No reason given', 1024) })
      .setTimestamp()],
    allowedMentions: { parse: [] },
  });
}

const safe = (name, fn) => async (...args) => {
  try {
    await fn(...args);
  } catch (e) {
    console.error(`${name} handler error:`, e);
  }
};

export function attachEvents(client) {
  client.on('messageCreate', safe('messageCreate', onMessage));
  client.on('messageUpdate', safe('messageUpdate', onMessageUpdate));
  client.on('messageDelete', safe('messageDelete', onMessageDelete));
  client.on('guildMemberAdd', safe('guildMemberAdd', onMemberAdd));
  client.on('guildMemberRemove', safe('guildMemberRemove', onMemberRemove));
  client.on('guildBanAdd', safe('guildBanAdd', onBanAdd));
  client.on('interactionCreate', safe('interactionCreate', onInteraction));
}
