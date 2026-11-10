// Posting to the per-server mod log and event log channels.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import { getSettings } from './store.js';
import { formatDuration, truncate } from './util.js';

export const COLORS = {
  scam: 0xE74C3C, automod: 0xE67E22, warn: 0xF1C40F, timeout: 0xE67E22, untimeout: 0x2ECC71,
  kick: 0xE67E22, softban: 0xC0392B, ban: 0xC0392B, unban: 0x2ECC71, note: 0x3498DB,
  info: 0x3498DB, ok: 0x2ECC71, raid: 0x8E44AD, edit: 0x3498DB, delete: 0x95A5A6,
  join: 0x2ECC71, leave: 0x95A5A6,
};

const ACTION_VERBS = {
  warn: 'warned', timeout: 'timed out', untimeout: 'timeout removed', kick: 'kicked',
  softban: 'softbanned', ban: 'banned', unban: 'unbanned', note: 'note added',
};

async function sendTo(guild, channelId, payload) {
  if (!channelId) return null;
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch?.isTextBased()) return null;
  return ch.send(payload).catch((e) => {
    console.error(`log send error in ${guild.name}:`, e.message);
    return null;
  });
}

export const sendModLog = (guild, payload) => sendTo(guild, getSettings(guild.id).logChannel, payload);
export const sendEventLog = (guild, payload) => sendTo(guild, getSettings(guild.id).eventLogChannel, payload);

export function caseEmbed(c) {
  const embed = new EmbedBuilder()
    .setColor(COLORS[c.type] ?? COLORS.info)
    .setTitle(`Case #${c.id}: ${c.type}${c.auto ? ' (auto)' : ''}`)
    .addFields(
      { name: 'User', value: `<@${c.userId}> \`${c.userTag}\` (${c.userId})`, inline: true },
      { name: 'Moderator', value: c.modId ? `<@${c.modId}> \`${c.modTag}\`` : c.modTag, inline: true },
    )
    .setTimestamp(new Date(c.createdAt));
  if (c.duration) embed.addFields({ name: 'Duration', value: formatDuration(c.duration), inline: true });
  embed.addFields({ name: 'Reason', value: truncate(c.reason || 'No reason given', 1000) });
  if (c.cleared) embed.setFooter({ text: 'Warning cleared' });
  return embed;
}

export const actionVerb = (type) => ACTION_VERBS[type] || type;

// Quick-action buttons attached to scam/automod log entries so mods can
// follow up with one click. Handled in interactions.js.
export function quickActionRow(userId, { unlearnHash } = {}) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mod:timeout:${userId}`).setLabel('Timeout 1d').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mod:kick:${userId}`).setLabel('Kick').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`mod:ban:${userId}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
  );
  if (unlearnHash) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`mod:unlearn:${unlearnHash}`).setLabel('False positive: forget image').setStyle(ButtonStyle.Success),
    );
  }
  return row;
}
