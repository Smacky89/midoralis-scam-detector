// Settings. CONFIG applies to every server the bot is in. SETTINGS_SCHEMA
// holds the per-server settings, which are changed live with `!config` / `/config`.

export const CONFIG = {
  token: process.env.DISCORD_TOKEN,

  // ── Image hash matching ──
  // How close a hash must be to count as a match (0 = identical,
  // higher = more lenient). 8 to 12 is a good range.
  matchThreshold: 10,

  // ── OCR tier (catches brand-new scams by reading text in the image) ──
  enableOcr: true,
  ocrScoreThreshold: 3,          // how many scam terms before it's flagged
  autoLearnFromOcr: true,        // auto-add the hash so reposts get the fast check
  maxImageBytes: 10 * 1024 * 1024, // skip images bigger than this (download + OCR cost)
  ocrMaxQueue: 25,               // if more images than this are waiting for OCR, skip OCR
  ocrTimeoutMs: 30_000,          // give up on a single OCR job after this long
  cleanImageCacheSize: 2000,     // remember this many recently-seen clean image hashes (skip re-OCR)
  ocrIdleShutdownMinutes: 5,     // unload the OCR engine (~120 MB RAM) after this long without images; 0 = keep loaded

  // ── Memory (hosts bill for RAM, so keep caches small) ──
  messageCacheSize: 50,          // messages kept per channel (for edit/delete logs)
  messageCacheMinutes: 60,       // drop cached messages older than this

  // Words/phrases commonly found in giveaway / crypto-casino scams.
  // Matched case-insensitively as substrings of the OCR'd or message text.
  scamTerms: [
    'promo code', 'promocode', 'bonus code', 'use code',
    'withdraw', 'free $', 'free bonus', '100% bonus', 'deposit bonus',
    'giveaway', 'crypto', 'bitcoin', 'casino', 'register and',
    'claim your', 'claim now', 'exclusive offer', 'limited time',
    'airdrop', 'double your', 'guaranteed profit', 'investment',
  ],

  // Phrases typical of Discord/Steam phishing ("free nitro", fake trades…).
  // One of these + a link to an unknown site is treated as phishing.
  phishingPhrases: [
    'free nitro', 'nitro for free', 'free discord nitro', 'nitro giveaway',
    'discord gift', 'steam gift', 'free steam', 'gift for you',
    'i\'m leaving cs', 'im leaving cs', 'take my skins', 'who wants my skins',
    'got a nitro', 'nitro from steam', 'claim your nitro', '3 months of discord nitro',
    'accidentally reported', 'mistakenly reported', 'report your account',
    'onlyfans leak', 'nudes leak', 'free onlyfans', '18+ leaks', 'teen leaks',
    'mrbeast giveaway', 'elon giveaway', 'airdrop is live', 'mint is live',
    'connect your wallet', 'verify your wallet', 'free mint',
  ],

  // Brands whose names scammers imitate in lookalike domains
  // (discorcl.gift, steamcommunlty.com, disc0rd-nitro.ru …).
  protectedBrands: [
    'discord', 'discordapp', 'steamcommunity', 'steampowered', 'steam',
    'roblox', 'epicgames', 'paypal', 'binance', 'coinbase', 'metamask',
    'opensea', 'telegram', 'instagram', 'twitch', 'youtube', 'google',
  ],

  // ── Domain blocklist (scans message TEXT for links) ──
  // Scam domains to start with, for example 'deezbet.com'. Add more live
  // with !adddomain. Learned ones persist.
  seedScamDomains: [],
  // Public, community-maintained phishing domain lists (~40k domains).
  // Refreshed every `phishingFeedRefreshHours`. Set to [] to disable.
  phishingFeeds: [
    'https://raw.githubusercontent.com/nikolaischunk/discord-phishing-links/main/domain-list.json',
    'https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.txt',
  ],
  phishingFeedRefreshHours: 6,

  // Domains that are always fine (never flagged as a suspicious URL).
  // Servers can add their own with `!config add allowedDomains example.com`.
  allowedDomains: [
    'discord.com', 'discord.gg', 'discordapp.com', 'discordapp.net', 'discord.new',
    'discord.gift', 'discord.media', 'discordstatus.com', 'dis.gd',
    'tenor.com', 'giphy.com', 'imgur.com',
    'youtube.com', 'youtu.be', 'twitch.tv',
    'twitter.com', 'x.com', 'github.com',
    'steamcommunity.com', 'steampowered.com', 'roblox.com', 'epicgames.com',
    'google.com', 'reddit.com', 'wikipedia.org', 'top.gg', 'disboard.org',
    'itch.io',
  ],

  // ── Notices / logs ──
  notice: 'Scam message was detected and auto-deleted.',
  noticeDeleteAfterSeconds: 10,
  maxLogAttachments: 5,          // cap how many images get re-uploaded per log entry
  maxAuditLogEntries: 200,       // how many !showlog entries to keep (oldest pruned)
  maxCasesPerGuild: 5000,        // moderation cases kept per server (oldest pruned)

  // ── Branding (shown on !postinfo, !status and !help) ──
  creatorName: 'Midoralis Game Studio',
  creatorUrl: 'https://midoralis.com/',
  repoUrl: 'https://github.com/Smacky89/midoralis-scam-detector',

  // ── Storage ──
  blocklistFile: process.env.BLOCKLIST_PATH || './scam-hashes.json',
};

// The credit line in embed footers: "Created by <name> · <site>".
export const CREDIT = `Created by ${CONFIG.creatorName} · ${CONFIG.creatorUrl.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;

// Per-server settings. Every key here can be changed live with
// `!config set <key> <value>` (or add/remove for lists). The `type`
// drives parsing + validation; `help` is shown in `!config` output.
export const SETTINGS_SCHEMA = {
  // General
  prefix: { type: 'string', default: '!', help: 'Command prefix for text commands.' },
  modRoles: { type: 'roles', default: [], help: 'Roles allowed to use moderation commands (in addition to Discord permissions).' },
  logChannel: { type: 'channel', default: null, help: 'Mod log: scams removed, automod hits, warns/timeouts/kicks/bans.' },
  eventLogChannel: { type: 'channel', default: null, help: 'Event log: edited/deleted messages, joins/leaves.' },
  dmOnAction: { type: 'bool', default: true, help: 'DM users when they are warned / timed out / kicked / banned.' },
  monitorOnly: { type: 'bool', default: false, help: 'Dry-run mode: log what WOULD be removed, but take no action. Great for tuning.' },

  // Scam detection
  scamDetection: { type: 'bool', default: true, help: 'Scan messages for scam links / images.' },
  scamAction: { type: 'action', default: 'delete', help: 'What to do to the author of a scam, on top of deleting it: delete | warn | timeout | kick | softban | ban.' },
  scamTimeout: { type: 'duration', default: 60 * 60_000, help: 'Timeout length when scamAction is timeout.' },
  scamPurgeRecent: { type: 'bool', default: true, help: 'When a scam is caught, also delete that user\'s other messages from the last 2 minutes (compromised-account spam).' },
  scamDmUser: { type: 'bool', default: true, help: 'DM the author that their account may be compromised.' },
  phishingHeuristics: { type: 'bool', default: true, help: 'Catch lookalike domains (discorcl.gift) and "free nitro + link" phishing.' },
  textScamRequiresKnownDomain: { type: 'bool', default: true, help: 'If off, "3+ scam words + unknown link" in plain text is also removed (more aggressive).' },
  allowedDomains: { type: 'strings', default: [], help: 'Extra domains that are always fine in this server.' },

  // AutoMod
  automod: { type: 'bool', default: true, help: 'Master switch for all automod rules below.' },
  exemptRoles: { type: 'roles', default: [], help: 'Roles that automod ignores (scam detection still applies).' },
  exemptChannels: { type: 'channels', default: [], help: 'Channels that automod ignores (scam detection still applies).' },
  automodAction: { type: 'action', default: 'warn', help: 'Default punishment for automod hits: delete | warn | timeout | kick | softban | ban.' },
  automodTimeout: { type: 'duration', default: 10 * 60_000, help: 'Timeout length when an automod rule times someone out.' },

  antiSpam: { type: 'bool', default: true, help: 'Too many messages too fast.' },
  spamMessages: { type: 'int', default: 6, min: 2, max: 50, help: 'Messages allowed within spamWindow before it counts as spam.' },
  spamWindow: { type: 'duration', default: 5_000, help: 'Window for antiSpam.' },
  antiDuplicate: { type: 'bool', default: true, help: 'Same message posted repeatedly / across channels (classic hacked-account spam).' },
  duplicateCount: { type: 'int', default: 3, min: 2, max: 20, help: 'Identical messages within duplicateWindow before action.' },
  duplicateWindow: { type: 'duration', default: 60_000, help: 'Window for antiDuplicate.' },
  duplicateAction: { type: 'action', default: 'timeout', help: 'Punishment for cross-channel duplicate spam.' },

  antiMassMention: { type: 'bool', default: true, help: 'Too many user/role mentions, or @everyone attempts without permission.' },
  maxMentions: { type: 'int', default: 5, min: 1, max: 50, help: 'Unique user + role mentions allowed in one message.' },

  antiInvites: { type: 'bool', default: true, help: 'Block invites to OTHER Discord servers.' },
  antiLinks: { type: 'bool', default: false, help: 'Block all links except allowed domains.' },
  newMemberLinkMinutes: { type: 'int', default: 10, min: 0, max: 10080, help: 'Members who joined less than this many minutes ago cannot post links (0 = off).' },

  antiCaps: { type: 'bool', default: false, help: 'Messages that are mostly CAPITAL LETTERS.' },
  capsPercent: { type: 'int', default: 75, min: 30, max: 100, help: 'Caps percentage that triggers antiCaps (messages 12+ letters).' },
  antiEmojiSpam: { type: 'bool', default: false, help: 'Too many emojis in one message.' },
  maxEmojis: { type: 'int', default: 12, min: 1, max: 100, help: 'Emojis allowed in one message.' },
  antiWallText: { type: 'bool', default: false, help: 'Huge walls of newlines.' },
  maxLines: { type: 'int', default: 25, min: 2, max: 200, help: 'Lines allowed in one message.' },
  antiZalgo: { type: 'bool', default: true, help: 'Zalgo / combining-character glitch text.' },

  badWords: { type: 'strings', default: [], help: 'Blocked words (leetspeak/spacing tricks are normalised). Use `*` suffix for prefix match, e.g. `slur*`.' },
  badWordsAction: { type: 'action', default: 'delete', help: 'Punishment for badWords hits.' },

  // Warnings + escalation
  warnExpiryDays: { type: 'int', default: 30, min: 0, max: 3650, help: 'Warnings older than this stop counting toward escalation (0 = never expire).' },
  escalation: { type: 'escalation', default: { 3: 'timeout 1h', 5: 'timeout 1d', 7: 'kick' }, help: 'Automatic punishment at N active warnings, e.g. `3=timeout 1h, 5=kick, 8=ban`.' },

  // Anti-raid / join gate  (needs the Server Members intent)
  antiRaid: { type: 'bool', default: true, help: 'Detect join floods and switch on raid mode automatically.' },
  raidJoins: { type: 'int', default: 20, min: 3, max: 200, help: 'Joins within raidWindow that trigger raid mode.' },
  raidWindow: { type: 'duration', default: 5_000, help: 'Window for antiRaid.' },
  raidModeDuration: { type: 'duration', default: 15 * 60_000, help: 'How long automatic raid mode stays on.' },
  raidAction: { type: 'action', default: 'kick', help: 'What happens to people who join while raid mode is on: timeout | kick | ban.' },
  minAccountAgeDays: { type: 'int', default: 0, min: 0, max: 3650, help: 'Accounts younger than this are actioned on join (0 = off).' },
  youngAccountAction: { type: 'action', default: 'kick', help: 'What happens to too-young accounts: timeout | kick | ban.' },
};

export const ACTIONS = ['delete', 'warn', 'timeout', 'kick', 'softban', 'ban'];
