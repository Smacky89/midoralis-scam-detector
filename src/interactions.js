// Slash commands, autocomplete, right-click context menus and the quick
// action buttons on mod log posts.
import {
  ApplicationCommandType, ContextMenuCommandBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits,
} from 'discord.js';
import {
  commands, buildSlash, readSlashOptions, slashContext, canUse, findCommand,
} from './commands/framework.js';
import { addScamImages } from './commands/scam.js';
import { reportMessage } from './commands/settings.js';
import { hasPermission, hierarchyError, punish } from './moderation.js';
import { forgetHash } from './scanner.js';
import { db } from './store.js';
import { sectionEmbed } from './status.js';

const CONTEXT_MENUS = [
  new ContextMenuCommandBuilder().setName('Report to mods').setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild),
  new ContextMenuCommandBuilder().setName('Add as scam image').setType(ApplicationCommandType.Message)
    .setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new ContextMenuCommandBuilder().setName('Mod history').setType(ApplicationCommandType.User)
    .setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
];

export async function registerSlashCommands(client) {
  const body = [...[...commands.values()].map(buildSlash), ...CONTEXT_MENUS.map((c) => c.toJSON())];
  try {
    // DEV_GUILD_ID registers instantly in one server (handy while testing).
    if (process.env.DEV_GUILD_ID) {
      await client.application.commands.set(body, process.env.DEV_GUILD_ID);
    } else {
      await client.application.commands.set(body);
    }
    console.log(`Registered ${body.length} slash/context commands.`);
  } catch (e) {
    console.error('Slash command registration failed:', e.message);
  }
}

const ephemeral = { flags: MessageFlags.Ephemeral };

export async function onInteraction(interaction) {
  if (!interaction.inGuild()) return;

  if (interaction.isAutocomplete()) {
    const def = commands.get(interaction.commandName);
    const focused = interaction.options.getFocused();
    const choices = def?.autocomplete ? def.autocomplete(String(focused)) : [];
    return interaction.respond(choices.slice(0, 25).map((c) => ({ name: c, value: c }))).catch(() => {});
  }

  if (interaction.isChatInputCommand()) {
    const def = findCommand(interaction.commandName);
    if (!def) return;
    if (!canUse(def, interaction.member)) {
      return interaction.reply({ content: 'You don\'t have permission to use this.', ...ephemeral });
    }
    await interaction.deferReply(ephemeral);
    const sub = def.subcommands ? interaction.options.getSubcommand() : null;
    const optionDefs = sub ? def.subcommands[sub].options : def.options;
    const { opts, error } = readSlashOptions(optionDefs, interaction);
    const ctx = slashContext(interaction, def, opts || {}, sub);
    if (error) return ctx.reply(`❌ ${error}`);
    try {
      await def.run(ctx);
    } catch (e) {
      console.error(`/${def.name} failed:`, e);
      await ctx.reply(`❌ Something went wrong: ${e.message}`);
    }
    return;
  }

  if (interaction.isMessageContextMenuCommand()) {
    const target = interaction.targetMessage;
    if (interaction.commandName === 'Report to mods') {
      const ok = await reportMessage(target, interaction.user, null);
      return interaction.reply({
        content: ok ? '✅ Reported. The mods have been notified.' : 'This server hasn\'t set up a mod log, so reports can\'t be delivered.',
        ...ephemeral,
      });
    }
    if (interaction.commandName === 'Add as scam image') {
      if (!hasPermission(interaction.member, PermissionFlagsBits.ManageGuild, { modRoleOk: false })) {
        return interaction.reply({ content: 'You need Manage Server for this.', ...ephemeral });
      }
      await interaction.deferReply(ephemeral);
      const r = await addScamImages([...target.attachments.values()], interaction.user.tag, 'added via right-click');
      if (!r.found) return interaction.editReply('That message has no images.');
      return interaction.editReply(`Added ${r.added} new hash(es)${r.dupes ? `, ${r.dupes} already covered` : ''}. ` +
        `Now ${db.blocklist.length} hashes. Delete the original message if it's still up.`);
    }
    return;
  }

  if (interaction.isUserContextMenuCommand() && interaction.commandName === 'Mod history') {
    const def = commands.get('warnings');
    if (!canUse(def, interaction.member)) return interaction.reply({ content: 'No permission.', ...ephemeral });
    await interaction.deferReply(ephemeral);
    return def.run(slashContext(interaction, def, { user: interaction.targetUser }));
  }

  if (interaction.isButton() && interaction.customId.startsWith('mod:')) {
    return onModButton(interaction);
  }

  // Detail pages under the !listscam card (shown only to whoever clicks).
  if (interaction.isButton() && interaction.customId.startsWith('status:')) {
    if (!canUse(commands.get('listscam'), interaction.member)) {
      return interaction.reply({ content: 'Only server managers can view this.', ...ephemeral });
    }
    const section = interaction.customId.split(':')[1];
    return interaction.reply({ embeds: [sectionEmbed(interaction.guild, section)], ...ephemeral });
  }
}

const BUTTON_PERMS = {
  timeout: PermissionFlagsBits.ModerateMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
  unlearn: PermissionFlagsBits.ManageGuild,
};

async function onModButton(interaction) {
  const [, action, arg] = interaction.customId.split(':');
  const perm = BUTTON_PERMS[action];
  if (!perm) return;
  const allowed = action === 'unlearn'
    ? hasPermission(interaction.member, perm, { modRoleOk: false })
    : hasPermission(interaction.member, perm);
  if (!allowed) return interaction.reply({ content: 'You don\'t have permission for that.', ...ephemeral });

  if (action === 'unlearn') {
    const ok = await forgetHash(arg);
    return interaction.reply({
      content: ok ? `✅ Forgot image hash \`${arg}\`. It won't be blocked any more. (Marked by ${interaction.user.tag})`
        : 'That hash is already gone.',
    });
  }

  await interaction.deferReply(ephemeral);
  const user = await interaction.client.users.fetch(arg).catch(() => null);
  if (!user) return interaction.editReply('Couldn\'t find that user.');
  const member = await interaction.guild.members.fetch(arg).catch(() => null);
  const err = hierarchyError(interaction.member, member, action);
  if (err) return interaction.editReply(`❌ ${err}`);
  const res = await punish({
    guild: interaction.guild, user, action, moderator: interaction.user,
    duration: action === 'timeout' ? 86_400_000 : undefined,
    deleteMessageSeconds: action === 'ban' ? 86_400 : undefined,
    reason: 'Quick action from mod log',
  });
  return interaction.editReply(res.ok ? `✅ ${user.tag}: ${action} (case #${res.case.id}).` : `❌ ${res.error}`);
}
