// Midoralis Scam Detector: entry point. Loads the data, connects to Discord
// and wires up the events and commands.
// © 2026 Midoralis Game Studio (https://midoralis.com/). MIT License, see LICENSE.

import 'dotenv/config';
import { Client, Events, GatewayCloseCodes, GatewayIntentBits, Options, Partials } from 'discord.js';
import { CONFIG, CREDIT } from './src/config.js';
import { loadAll, flushAll } from './src/store.js';
import { startFeedRefresh } from './src/detect/feeds.js';
import { attachEvents } from './src/events.js';
import { registerSlashCommands } from './src/interactions.js';
import { shutdownOcr } from './src/scanner.js';
// Command definitions register themselves on import.
import './src/commands/scam.js';
import './src/commands/moderation.js';
import './src/commands/settings.js';
import './src/commands/info.js';

if (!CONFIG.token) {
  console.error('DISCORD_TOKEN is not set. See README → "Add your token".');
  process.exit(1);
}

const BASE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,  // privileged, required
  GatewayIntentBits.GuildModeration, // ban events for the event log
];
// Privileged, optional: join/leave events for anti-raid, account-age gate
// and join logs. If it isn't enabled in the Developer Portal the bot still
// starts, just without those features.
const MEMBER_INTENT = GatewayIntentBits.GuildMembers;

function createClient(withMembers) {
  const client = new Client({
    intents: withMembers ? [...BASE_INTENTS, MEMBER_INTENT] : BASE_INTENTS,
    partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
    allowedMentions: { parse: ['users'], repliedUser: false },
    // Keep memory flat as the bot joins more servers (hosts bill for RAM).
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: CONFIG.messageCacheSize,
      ReactionManager: 0,
      PresenceManager: 0,
      VoiceStateManager: 0,
      StageInstanceManager: 0,
      GuildScheduledEventManager: 0,
    }),
    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 600, lifetime: CONFIG.messageCacheMinutes * 60 },
    },
  });
  client.once(Events.ClientReady, async () => {
    console.log(`Midoralis Scam Detector, ${CREDIT}`);
    console.log(`Logged in as ${client.user.tag}, in ${client.guilds.cache.size} server(s).`);
    if (!withMembers) {
      console.warn('⚠️  Server Members intent is off: anti-raid, account-age gate and join/leave logs are disabled. ' +
        'Enable it in the Developer Portal → Bot → Privileged Gateway Intents.');
    }
    await registerSlashCommands(client);
  });
  attachEvents(client);
  client.on('error', (e) => console.error('client error:', e.message));
  return client;
}

// Resolves with a ready client, or rejects. When a privileged intent isn't
// enabled, Discord closes the gateway with code 4014. discord.js reports
// that as a permanent shard disconnect rather than a login error.
function connect(withMembers) {
  return new Promise((resolve, reject) => {
    const client = createClient(withMembers);
    const fail = (err) => {
      client.off(Events.ShardDisconnect, onDisconnect);
      client.destroy().finally(() => reject(err));
    };
    const onDisconnect = (event) => {
      if (event.code === GatewayCloseCodes.DisallowedIntents) fail(new Error('Used disallowed intents'));
    };
    client.on(Events.ShardDisconnect, onDisconnect);
    client.once(Events.ClientReady, () => {
      client.off(Events.ShardDisconnect, onDisconnect);
      resolve(client);
    });
    client.login(CONFIG.token).catch(fail);
  });
}

async function start() {
  await loadAll(); // load data BEFORE connecting so no message is scanned against an empty list
  startFeedRefresh();

  let client;
  try {
    client = await connect(true);
  } catch (e) {
    if (!/disallowed intents|privileged intent/i.test(e.message)) throw e;
    console.warn('Server Members intent not enabled, reconnecting without it.');
    client = await connect(false);
  }

  const shutdown = async (signal) => {
    console.log(`${signal} received, saving and shutting down…`);
    await flushAll().catch(() => {});
    await shutdownOcr();
    await client.destroy();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

start().catch((e) => {
  console.error('Failed to start:', e.message);
  if (/disallowed intents/i.test(e.message)) {
    console.error('→ Enable "Message Content Intent" in the Developer Portal → Bot → Privileged Gateway Intents.');
  }
  process.exit(1);
});
