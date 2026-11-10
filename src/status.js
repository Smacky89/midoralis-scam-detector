// The `!listscam` / `/status` card: what's active, what happens to rule
// breakers, and a setup check (permissions, role position, log channel,
// intents). The buttons underneath open a detailed explanation of each part.
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, GatewayIntentBits, PermissionFlagsBits,
} from 'discord.js';
import { CONFIG, CREDIT } from './config.js';
import { db, getSettings } from './store.js';
import { parseStep } from './moderation.js';
import { COLORS } from './logging.js';
import { formatDuration, truncate } from './util.js';

const P = PermissionFlagsBits;
const on = (b) => (b ? '✅' : '❌');
const num = (x) => x.toLocaleString('en-US');

// Plain-English outcome of an action setting.
function outcome(action, timeoutMs) {
  switch (action) {
    case 'delete': return 'deleted';
    case 'warn': return 'deleted + warning';
    case 'timeout': return `deleted + ${formatDuration(timeoutMs)} timeout`;
    case 'kick': return 'deleted + **kick**';
    case 'softban': return 'deleted + **softban** (kick + wipe 24h of messages)';
    case 'ban': return 'deleted + **BAN**';
    default: return action;
  }
}

// For join-time actions (no message to delete).
const joinVerb = (action) => ({ timeout: 'timed out', kick: 'kicked', ban: '**banned**', softban: 'softbanned', warn: 'warned', delete: 'left alone' }[action] || action);

function escalationText(s) {
  const steps = Object.entries(s.escalation || {}).sort((a, b) => a[0] - b[0]);
  if (!steps.length) return 'Warnings are recorded but never lead to automatic punishment.';
  return `${steps.map(([count, step]) => `${count} → ${step}`).join(' · ')}` +
    `${s.warnExpiryDays ? ` (warnings expire after ${s.warnExpiryDays} days)` : ''}`;
}

// Every automatic action the current settings can take.
function automaticActions(s) {
  const list = [];
  if (s.scamDetection) list.push(s.scamAction);
  if (s.automod) {
    list.push(s.automodAction);
    if (s.antiDuplicate) list.push(s.duplicateAction);
    if (s.badWords.length) list.push(s.badWordsAction);
  }
  for (const step of Object.values(s.escalation || {})) list.push(parseStep(step)?.action);
  if (s.antiRaid) list.push(s.raidAction);
  if (s.minAccountAgeDays > 0) list.push(s.youngAccountAction);
  return new Set(list.filter(Boolean));
}

// ── setup check ──────────────────────────────────────────────
function setupCheck(guild) {
  const s = getSettings(guild.id);
  const me = guild.members.me;
  const perms = me.permissions;
  const actions = automaticActions(s);
  const problems = [];   // ❌ breaks something the current settings rely on
  const warnings = [];   // ⚠️ worth fixing
  const ok = [];

  if (perms.has(P.Administrator)) {
    ok.push('Bot has **Administrator** (all permissions)');
  } else {
    const need = [
      [P.ViewChannel, 'View Channels', true, 'see messages'],
      [P.ManageMessages, 'Manage Messages', true, 'delete scams'],
      [P.ReadMessageHistory, 'Read Message History', true, 'clean up spam bursts'],
      [P.EmbedLinks, 'Embed Links', true, 'post logs'],
      [P.AttachFiles, 'Attach Files', true, 'upload scam images to the log'],
      [P.ModerateMembers, 'Timeout Members', actions.has('timeout'), 'timeouts'],
      [P.KickMembers, 'Kick Members', actions.has('kick'), 'kicks'],
      [P.BanMembers, 'Ban Members', actions.has('ban') || actions.has('softban'), 'bans'],
      [P.ManageChannels, 'Manage Channels', false, '!slowmode / !lock'],
      [P.ManageRoles, 'Manage Roles', false, '!lock / !lockdown'],
      [P.ViewAuditLog, 'View Audit Log', false, 'showing who banned someone in the event log'],
    ];
    const missingRequired = need.filter(([bit, , req]) => req && !perms.has(bit));
    const missingOptional = need.filter(([bit, , req]) => !req && !perms.has(bit));
    for (const [, name, , why] of missingRequired) problems.push(`Missing **${name}** permission: needed for ${why}`);
    if (missingOptional.length) {
      warnings.push(`Optional permissions missing: ${missingOptional.map(([, name, , why]) => `**${name}** (${why})`).join(', ')}`);
    }
    if (!missingRequired.length) ok.push('Bot has every permission your settings need');
  }

  // Member roles above the bot can't be timed out / kicked by it.
  const top = me.roles.highest.position;
  const staffPerms = [P.Administrator, P.ManageGuild, P.ManageMessages, P.ModerateMembers, P.KickMembers, P.BanMembers];
  const above = guild.roles.cache.filter((r) =>
    r.id !== guild.id && !r.managed && r.position > top && !staffPerms.some((p) => r.permissions.has(p)));
  if (above.size) {
    warnings.push(`${above.size} member role(s) are above the bot (${[...above.values()].slice(0, 4).map((r) => `<@&${r.id}>`).join(' ')}` +
      `${above.size > 4 ? '…' : ''}). It can't timeout/kick people with them. Drag the bot's role higher in **Server Settings → Roles**.`);
  } else {
    ok.push('Bot\'s role is above all member roles');
  }

  // Public channels the bot can't protect.
  const everyone = guild.roles.everyone;
  const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice];
  const blind = guild.channels.cache.filter((ch) => textTypes.includes(ch.type) &&
    ch.permissionsFor(everyone)?.has([P.ViewChannel, P.SendMessages]) &&
    !ch.permissionsFor(me)?.has([P.ViewChannel, P.ManageMessages]));
  if (blind.size) {
    problems.push(`Can't see or delete messages in ${blind.size} public channel(s): ` +
      `${[...blind.values()].slice(0, 5).map((c) => `<#${c.id}>`).join(' ')}${blind.size > 5 ? '…' : ''}`);
  } else {
    ok.push('Bot can moderate every public channel');
  }

  // Mod log
  if (!s.logChannel) {
    warnings.push('No mod log. Run `!setlogchannel` in a staff-only channel to see what the bot removes');
  } else {
    const ch = guild.channels.cache.get(s.logChannel);
    if (!ch) problems.push('The mod log channel was deleted. Run `!setlogchannel` again');
    else if (!ch.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles])) {
      problems.push(`Bot can't post in the mod log <#${ch.id}> (needs View, Send Messages, Embed Links, Attach Files there)`);
    } else ok.push(`Mod log posts to <#${ch.id}>`);
  }

  // Intents
  if (!guild.client.options.intents.has(GatewayIntentBits.GuildMembers)) {
    warnings.push('**Server Members Intent** is off, so anti-raid, the account-age check and join/leave logs don\'t run. ' +
      'Turn it on at discord.com/developers → your app → Bot → Privileged Gateway Intents, then restart the bot.');
  } else ok.push('Server Members intent is on');

  if (s.monitorOnly) warnings.push('**Monitor mode is ON**: nothing is deleted or punished, only logged (`!config set monitorOnly off`)');

  return { problems, warnings, ok };
}

// ── main card ────────────────────────────────────────────────
export function statusEmbed(guild) {
  const s = getSettings(guild.id);
  const check = setupCheck(guild);
  const membersIntent = guild.client.options.intents.has(GatewayIntentBits.GuildMembers);
  const actions = automaticActions(s);

  const headline = check.problems.length
    ? `❌ **${check.problems.length} problem(s) need fixing**: see Setup check.`
    : check.warnings.length
      ? `⚠️ **Working**, with ${check.warnings.length} thing(s) worth a look, see Setup check.`
      : '✅ **Everything is set up correctly.**';

  const setupLines = [
    ...check.problems.map((p) => `❌ ${p}`),
    ...check.warnings.map((w) => `⚠️ ${w}`),
    ...(check.problems.length || check.warnings.length ? [] : check.ok.map((o) => `✅ ${o}`)),
  ];

  const scam = s.scamDetection
    ? [
      `✅ **On.** Removes scam links and scam images from everyone (staff included).`,
      `Knows **${num(db.feedDomains.size)}** phishing sites + **${num(db.scamDomains.size)}** you added + **${num(db.blocklist.length)}** scam images.`,
      `${on(CONFIG.enableOcr)} Reads text in new images (OCR) · ${on(s.phishingHeuristics)} Spots fake look-alike links`,
      `**Scammer:** message ${outcome(s.scamAction, s.scamTimeout)}` +
        `${s.scamPurgeRecent ? ', their last 2 min of messages removed' : ''}${s.scamDmUser ? ', DM\'d that they may be hacked' : ''}.`,
    ].join('\n')
    : '❌ **Off**: scam links and images are NOT removed. `!config set scamDetection on`';

  const rules = [
    ['antiSpam', 'Spam', `${s.spamMessages}+ messages in ${formatDuration(s.spamWindow)}`, s.automodAction, s.automodTimeout],
    ['antiDuplicate', 'Duplicates', `same message ${s.duplicateCount}× in ${formatDuration(s.duplicateWindow)} (hacked accounts)`, s.duplicateAction, s.automodTimeout],
    ['antiMassMention', 'Mentions', `more than ${s.maxMentions} pings`, s.automodAction, s.automodTimeout],
    ['antiInvites', 'Invites', 'invites to other servers', 'delete'],
    ['antiZalgo', 'Zalgo', 'glitchy "zalgo" text full of stacked accents', 'delete'],
    ['antiLinks', 'Links', 'any link that isn\'t an allowed site', 'delete'],
    ['antiCaps', 'Caps', `${s.capsPercent}%+ CAPITALS`, 'delete'],
    ['antiEmojiSpam', 'Emoji', `more than ${s.maxEmojis} emojis`, 'delete'],
    ['antiWallText', 'Walls', `more than ${s.maxLines} lines`, 'delete'],
  ];
  let automod;
  if (!s.automod) {
    automod = '❌ **Off**: only scams are removed. `!config set automod on`';
  } else {
    const active = rules.filter(([k]) => s[k]).map(([, label, what, action, t]) => `✅ **${label}**: ${what} → ${outcome(action, t)}`);
    if (s.newMemberLinkMinutes > 0) active.push(`✅ **New members**: no links for their first ${s.newMemberLinkMinutes} min → deleted`);
    if (s.badWords.length) active.push(`✅ **Bad words**: ${s.badWords.length} word(s) → ${outcome(s.badWordsAction, s.automodTimeout)}`);
    const off = rules.filter(([k]) => !s[k]).map(([, label]) => label);
    if (!s.badWords.length) off.push('Bad words');
    if (off.length) active.push(`❌ Off: ${off.join(', ')}`);
    automod = active.join('\n');
  }

  const bans = [...actions].filter((a) => a === 'ban' || a === 'softban');
  const punish = [
    `**Warnings add up:** ${escalationText(s)}`,
    bans.length ? '🔨 **Some settings can ban automatically**: press ⚖️ Punishments below to see which.' : '🕊️ **Nobody is ever banned automatically.**',
    'Mods and admins are never hit by AutoMod.',
  ].join('\n');

  let raid;
  if (!membersIntent) raid = '⚠️ **Not running**: needs the Server Members Intent (see Setup check).';
  else {
    raid = [
      `${on(s.antiRaid)} **Raid detection**: ${s.raidJoins}+ joins in ${formatDuration(s.raidWindow)} → for ${formatDuration(s.raidModeDuration)} new joiners are ${joinVerb(s.raidAction)}`,
      s.minAccountAgeDays > 0
        ? `✅ **New accounts**: younger than ${s.minAccountAgeDays} days → ${joinVerb(s.youngAccountAction)} when they join`
        : '❌ **New-account check** off (`!config set minAccountAgeDays 7`)',
    ].join('\n');
  }

  const logs = `Mod log: ${s.logChannel ? `<#${s.logChannel}>` : '**not set** (`!setlogchannel`)'} · ` +
    `Event log: ${s.eventLogChannel ? `<#${s.eventLogChannel}>` : 'not set'}`;

  return new EmbedBuilder()
    .setColor(check.problems.length ? COLORS.scam : check.warnings.length ? COLORS.warn : COLORS.ok)
    .setTitle('🛡️ Midoralis Scam Detector: status')
    .setURL(CONFIG.creatorUrl)
    .setDescription(`${headline}${s.monitorOnly ? '\n👀 **Monitor mode**: nothing is removed, only logged.' : ''}`)
    .addFields(
      { name: '🔧 Setup check', value: truncate(setupLines.join('\n'), 1024) },
      { name: '🚫 Scam protection', value: truncate(scam, 1024) },
      { name: '🤖 AutoMod', value: truncate(automod, 1024) },
      { name: '⚖️ Punishments', value: truncate(punish, 1024) },
      { name: '🚨 Anti-raid', value: truncate(raid, 1024) },
      { name: '📋 Logs', value: logs },
    )
    .setFooter({ text: `${CREDIT} · Change anything with ${s.prefix}config · Buttons below explain each part` });
}

export function statusButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('status:scam').setLabel('Scam protection').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('status:automod').setLabel('AutoMod').setEmoji('🤖').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('status:punish').setLabel('Punishments').setEmoji('⚖️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('status:setup').setLabel('Setup help').setEmoji('🔧').setStyle(ButtonStyle.Secondary),
  );
}

// ── detail pages (shown privately when a button is pressed) ──
export function sectionEmbed(guild, section) {
  const s = getSettings(guild.id);
  const p = s.prefix;
  const e = new EmbedBuilder().setColor(COLORS.info).setFooter({ text: CREDIT });

  if (section === 'scam') {
    return e.setTitle('🚫 Scam protection: how it works').setDescription([
      '**What gets removed**',
      '• **Known phishing links**: a public list of ~40,000 scam sites, updated every 6 hours, plus any you add with `' + p + 'adddomain site.com`.',
      '• **Known scam images**: teach one by replying to it with `' + p + 'addscam` (or right-click → Apps → Add as scam image). Reposts are caught even if cropped or recompressed.',
      '• **New scam images**: the bot reads text in images (OCR). Casino/crypto/"promo code" screenshots are removed and learned automatically.',
      '• **Fake look-alike links**: `dlscord.com`, `steamcommunnity.com`, links whose text shows one site but go to another, "free nitro" + unknown link.',
      '• Edited messages are checked again (scammers often edit the link in later).',
      '',
      '**What happens to the scammer**',
      `• Message deleted, a short notice is shown, and it's posted in the mod log with the image.`,
      `• ${s.scamPurgeRecent ? 'Their other messages from the last 2 minutes are removed too (hacked accounts spam every channel).' : 'Only the scam message is removed (`scamPurgeRecent` is off).'}`,
      `• ${s.scamDmUser ? 'They get a DM saying their account may be hacked, with steps to secure it.' : 'No DM is sent (`scamDmUser` is off).'}`,
      `• Punishment: **${outcome(s.scamAction, s.scamTimeout)}** (\`${p}config set scamAction delete|warn|timeout|kick|ban\`).`,
      '',
      '**False positive?** Press *False positive: forget image* in the mod log, or `' + p + 'removedomain site.com`.',
      'Test any link safely with `' + p + 'check <link>`.',
    ].join('\n'));
  }

  if (section === 'automod') {
    return e.setTitle('🤖 AutoMod: the rules').setDescription([
      'AutoMod handles normal chat. **Mods, admins and exempt roles/channels are ignored.**',
      '',
      `**Spam** \`antiSpam\`: ${s.spamMessages}+ messages in ${formatDuration(s.spamWindow)}.`,
      `**Duplicates** \`antiDuplicate\`: the same message ${s.duplicateCount}× within ${formatDuration(s.duplicateWindow)}, even in different channels. Every copy is removed.`,
      `**Mentions** \`antiMassMention\`: more than ${s.maxMentions} people/roles pinged in one message.`,
      '**Invites** `antiInvites`: invite links to other Discord servers (your own are fine).',
      `**New members** \`newMemberLinkMinutes\`: people who joined less than ${s.newMemberLinkMinutes || 'X'} minutes ago can't post links${s.newMemberLinkMinutes ? '' : ' (off)'}.`,
      '**Zalgo** `antiZalgo`: glitchy text full of stacked accent marks that spills over other messages.',
      '**Links** `antiLinks`: blocks every link except allowed sites (add yours: `' + p + 'config add allowedDomains site.com`).',
      `**Caps** \`antiCaps\`: ${s.capsPercent}%+ capital letters. **Emoji** \`antiEmojiSpam\`: over ${s.maxEmojis}. **Walls** \`antiWallText\`: over ${s.maxLines} lines.`,
      '**Bad words**: `' + p + 'config add badWords word1 word2`. Tricks like `b4dw0rd` or `b a d` are caught too.',
      '',
      '**Turning rules on/off:** `' + p + 'config set antiCaps on` · `' + p + 'config set antiSpam off`',
      '**Skip a channel or role:** `' + p + 'config add exemptChannels #memes` · `' + p + 'config add exemptRoles @Trusted`',
      '**Everything off:** `' + p + 'config set automod off` (scam protection keeps working).',
    ].join('\n'));
  }

  if (section === 'punish') {
    const steps = Object.entries(s.escalation || {});
    return e.setTitle('⚖️ Punishments: what happens to rule breakers').setDescription([
      '**Per rule**',
      `• Scams → ${outcome(s.scamAction, s.scamTimeout)} (\`scamAction\`)`,
      `• Spam, mentions → ${outcome(s.automodAction, s.automodTimeout)} (\`automodAction\`)`,
      `• Duplicates → ${outcome(s.duplicateAction, s.automodTimeout)} (\`duplicateAction\`)`,
      `• Bad words → ${outcome(s.badWordsAction, s.automodTimeout)} (\`badWordsAction\`)`,
      '• Invites, links, caps, emoji, walls, zalgo, new-member links → deleted only',
      `• People joining during a raid → ${joinVerb(s.raidAction)} (\`raidAction\`) · too-new accounts → ${joinVerb(s.youngAccountAction)} (\`youngAccountAction\`)`,
      '',
      '**Warnings add up**',
      steps.length ? steps.map(([c, step]) => `• ${c} warnings → ${step}`).join('\n') : '• No automatic escalation.',
      s.warnExpiryDays ? `• Warnings older than ${s.warnExpiryDays} days stop counting.` : '• Warnings never expire.',
      '• A burst of spam only counts as one warning.',
      '',
      '**Make it gentler (delete only, no warnings or timeouts)**',
      '`' + p + 'config set automodAction delete`',
      '`' + p + 'config set duplicateAction delete`',
      '`' + p + 'config set escalation none`',
      '',
      '**Change the steps:** `' + p + 'config set escalation 3=timeout 1h, 5=timeout 1d, 7=kick`',
      'Mods can always act by hand: `' + p + 'warn`, `' + p + 'timeout`, `' + p + 'kick`, `' + p + 'ban`, and see anyone\'s record with `' + p + 'warnings @user`.',
    ].join('\n'));
  }

  // setup
  const check = setupCheck(guild);
  return e.setTitle('🔧 Setup help').setDescription(truncate([
    ...check.problems.map((x) => `❌ ${x}`),
    ...check.warnings.map((x) => `⚠️ ${x}`),
    ...check.ok.map((x) => `✅ ${x}`),
    '',
    '**Fixing permissions:** Server Settings → Roles → *(the bot\'s role)* → turn on Manage Messages, Read Message History, ' +
      'Embed Links, Attach Files, Timeout Members, Kick Members (and Ban Members / Manage Channels / Manage Roles / View Audit Log for the extra mod commands).',
    '**Role order:** in Server Settings → Roles, drag the bot\'s role above your member roles. It can never act on roles above it.',
    '',
    `**Useful commands:** \`${p}setlogchannel\` · \`${p}config set eventLogChannel #logs\` · \`${p}config add modRoles @Mods\` · \`${p}config\` (all settings) · \`${p}help\``,
  ].join('\n'), 4000));
}
