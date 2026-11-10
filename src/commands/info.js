// `!postinfo`: a public "what is this bot" message for an info channel:
// what it does, the commands regular members can use, safety tips, and where
// to get the bot for another server (GitHub link). Re-running it edits the
// existing post instead of posting a duplicate.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { register } from './framework.js';
import { CONFIG, CREDIT } from '../config.js';
import { db, getSettings, guildState, saveGuilds } from '../store.js';
import { COLORS } from '../logging.js';

function activeRules(s) {
  if (!s.automod) return null;
  const rules = [
    [s.antiSpam, 'flooding the chat'],
    [s.antiDuplicate, 'posting the same message over and over'],
    [s.antiMassMention, 'mass pings'],
    [s.antiInvites, 'invites to other servers'],
    [s.newMemberLinkMinutes > 0, `links in your first ${s.newMemberLinkMinutes} minutes after joining`],
    [s.antiLinks, 'links to sites that aren\'t allowed'],
    [s.antiCaps, 'ALL-CAPS messages'],
    [s.antiEmojiSpam, 'emoji spam'],
    [s.antiWallText, 'huge walls of text'],
    [s.antiZalgo, 'glitchy "zalgo" text'],
    [s.badWords.length > 0, 'blocked words'],
  ];
  return rules.filter(([on]) => on).map(([, label]) => label);
}

export function infoPost(guild) {
  const s = getSettings(guild.id);
  const p = s.prefix;
  const creator = `[${CONFIG.creatorName}](${CONFIG.creatorUrl})`;
  const rules = activeRules(s);

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🛡️ MidoralisScamDetector')
    .setURL(CONFIG.creatorUrl)
    .setDescription(
      '## This Discord server is protected by MidoralisScamDetector\n' +
      'MidoralisScamDetector automatically removes scams and keeps the chat clean, ' +
      'so you can hang out without worrying about dodgy links.',
    )
    .addFields(
      {
        name: '🚫 What it does',
        value: [
          `• Removes **scam and phishing links**: over ${Math.floor(db.feedDomains.size / 1000) || 40},000 known scam sites, plus fake look-alikes like \`dlscord.com\``,
          '• Removes **scam images**: fake giveaways, crypto-casino and "promo code" screenshots, even new ones it has never seen',
          '• Stops **hacked accounts** that spam the same message in every channel',
          '• Protects the server from **raids** (floods of bot accounts joining)',
        ].join('\n'),
      },
      ...(rules?.length ? [{
        name: '📏 Also removed automatically',
        value: rules.map((r) => `• ${r[0].toUpperCase()}${r.slice(1)}`).join('\n'),
      }] : []),
      {
        name: '🙋 Commands you can use',
        value: [
          `\`${p}report [reason]\`: **reply** to a message with this to report it privately to the mods`,
          '**Right-click** (or long-press) a message → **Apps → Report to mods**: same thing, no typing needed',
          `\`${p}help\`: list the commands you can use`,
          `\`${p}ping\`: check the bot is online`,
        ].join('\n'),
      },
      {
        name: '❓ Was your message removed?',
        value: [
          '• **If you didn\'t send it, your account may be hacked.** Change your password, turn on 2-factor authentication, ' +
            'and remove anything you don\'t recognise under *User Settings → Authorized Apps*.',
          '• If you think the bot made a mistake, just let a moderator know.',
        ].join('\n'),
      },
      {
        name: '🔒 Stay safe',
        value: [
          '• Discord never gives away free Nitro through links in chat or DMs.',
          '• Staff will **never** ask for your password, or ask you to "verify" your account on a website.',
          '• Never scan QR codes from strangers; they can log into your account.',
        ].join('\n'),
      },
      {
        name: '💼 Want this bot in your own server?',
        value: `MidoralisScamDetector is created by **${creator}** and is free and open source. You can get the code and set it up for your own Discord server from [GitHub](${CONFIG.repoUrl}).`,
      },
    )
    .setFooter({ text: CREDIT });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(CONFIG.repoUrl).setLabel('Get the bot on GitHub'),
  );
  return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

register({
  name: 'postinfo', aliases: ['infopost'], category: 'Setup', level: 'admin', perm: PermissionFlagsBits.ManageGuild,
  description: 'Post (or update) the public info message about the bot in this channel.',
  options: [{ name: 'channel', type: 'channel', description: 'Channel to post in (default: this one)' }],
  async run(ctx) {
    const channel = ctx.opts.channel || ctx.channel;
    const g = guildState(ctx.guild.id);
    const payload = infoPost(ctx.guild);
    if (ctx.message) await ctx.message.delete().catch(() => {});

    // Update the existing post if it's still in this channel.
    let msg = null;
    if (g.infoPost?.channelId === channel.id) {
      msg = await channel.messages.fetch(g.infoPost.messageId).catch(() => null);
      if (msg) await msg.edit(payload).catch(() => { msg = null; });
    }
    const updated = !!msg;
    if (!msg) {
      msg = await channel.send(payload).catch((e) => e);
      if (msg instanceof Error) return ctx.reply(`❌ Couldn't post in <#${channel.id}>: ${msg.message}`);
    }
    g.infoPost = { channelId: channel.id, messageId: msg.id };
    await saveGuilds();

    const text = updated ? `✅ Updated the info message in <#${channel.id}>.` : `✅ Posted the info message in <#${channel.id}>.`;
    if (ctx.isSlash) return ctx.reply(text);
    // Text command: show a short confirmation, then remove it.
    const r = await channel.send({ content: text, flags: MessageFlags.SuppressNotifications }).catch(() => null);
    if (r) setTimeout(() => r.delete().catch(() => {}), 5000);
  },
});
