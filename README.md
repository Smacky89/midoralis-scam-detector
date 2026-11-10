# Midoralis Scam Detector

**A free Discord bot that removes scams and keeps your server clean.**

It deletes scam images, phishing links and hacked-account spam the moment they
are posted. It also does everyday moderation: automod, warnings, timeouts, kicks,
bans, anti-raid and full mod logs.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Node.js 20.9+](https://img.shields.io/badge/node-20.9%2B-brightgreen.svg)
![discord.js 14](https://img.shields.io/badge/discord.js-14-5865F2.svg)

Created by [Midoralis Game Studio](https://midoralis.com/). Free and open source
under the [MIT License](LICENSE).

---

## Contents

- [What is it for?](#what-is-it-for)
- [What it does](#what-it-does)
- [What you need](#what-you-need)
- [Install it, step by step](#install-it-step-by-step)
- [First setup in your server](#first-setup-in-your-server)
- [How the scam detection works](#how-the-scam-detection-works)
- [AutoMod, warnings and anti-raid](#automod-warnings-and-anti-raid)
- [Commands](#commands)
- [Settings](#settings)
- [Keep it online 24/7](#keep-it-online-247)
- [Problems and fixes](#problems-and-fixes)
- [What the bot stores](#what-the-bot-stores)
- [For developers](#for-developers)
- [Support the project](#support-the-project)
- [License](#license)

---

## What is it for?

Scammers hack Discord accounts and use them to post fake giveaways, casino
"promo code" screenshots and "free Nitro" links in every channel. Members trust
the account, click the link, and lose their own account too.

This bot stops that. You run your own copy, invite it to your server, and it
removes the scam within a second, tells the hacked user what happened, and shows
your moderators what it did.

It is made for server owners and moderators. You do not need to be a programmer
to set it up. The steps below explain everything.

## What it does

- **Removes scam images.** Fake giveaways and casino or crypto screenshots, even
  ones it has never seen before, because it reads the text inside the image.
- **Removes phishing links.** About 40,000 known scam sites, plus fake look-alike
  addresses such as `dlscord.com`.
- **Stops hacked accounts.** The same message posted in many channels is removed
  everywhere, and the user is told how to secure their account.
- **AutoMod.** Spam, mass mentions, invite links, bad words and more.
- **Warnings that add up.** For example 3 warnings give a 1 hour timeout.
- **Anti-raid.** Detects a flood of new accounts joining and acts on it.
- **Mod log with buttons.** Every removal is posted for your moderators with
  one-click Timeout, Kick, Ban and "False positive" buttons.
- **Works your way.** Every command works as `!command` and as `/command`, and
  each server has its own settings.

## What you need

- A computer or server that can stay on while the bot runs.
- [Node.js](https://nodejs.org/) version 20.9 or newer.
- A Discord account with permission to add bots to your server.
- About 15 minutes.

---

## Install it, step by step

### Step 1. Install Node.js

Download it from [nodejs.org](https://nodejs.org/) and install it. Then open a
terminal (on Windows: PowerShell) and check that it works:

```bash
node -v
npm -v
```

Both commands should print a version number. `node -v` must show 20.9 or higher.

### Step 2. Download the bot

**Easy way:** on the GitHub page press the green **Code** button, choose
**Download ZIP**, and extract it.

**With Git:**

```bash
git clone https://github.com/Smacky89/midoralis-scam-detector.git
```

Then go into the folder in your terminal:

```bash
cd midoralis-scam-detector
```

### Step 3. Install the parts it needs

```bash
npm install
```

This downloads the libraries the bot uses. It can take a minute.

### Step 4. Create your bot in Discord

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Press **New Application**, give it a name, and create it.
3. Open the **Bot** tab, press **Reset Token**, and copy the token.
   Keep it secret. The token is the password of your bot.
4. On the same **Bot** tab, under **Privileged Gateway Intents**, switch on:
   - **Message Content Intent** (required, the bot cannot read messages without it)
   - **Server Members Intent** (recommended, needed for anti-raid and join logs)

### Step 5. Invite the bot to your server

1. In the Developer Portal open **OAuth2**, then **URL Generator**.
2. Under **Scopes** tick `bot` and `applications.commands`.
3. Under **Bot Permissions** tick:
   - View Channels, Send Messages, Embed Links, Attach Files, Read Message History
   - Manage Messages (to delete scams)
   - Timeout Members, Kick Members, Ban Members (for punishments)
   - Manage Channels and Manage Roles (for slowmode, lock and lockdown)
   - View Audit Log (to show who banned someone in the event log)

   You can also use this permission number in the invite link: `1099780189334`.
4. Copy the link at the bottom, open it in your browser, and pick your server.
5. In your server go to **Server Settings**, then **Roles**, and drag the bot's
   role **above** the roles of the people it should be able to moderate.

### Step 6. Give the bot your token

In the bot folder, make a copy of the file `.env.example` and name the copy
`.env`. Open `.env` in a text editor and put your token in:

```
DISCORD_TOKEN=paste_your_token_here
```

Save the file. Never share this file or upload it anywhere.

### Step 7. Start the bot

```bash
npm start
```

You should see something like this:

```
Midoralis Scam Detector
Created by Midoralis Game Studio · https://midoralis.com/
Logged in as YourBot#1234, in 1 server(s).
Registered 36 slash/context commands.
Phishing feeds: 39610 domains from 2/2 source(s).
```

The bot is now online. It only runs while this window is open. To keep it
online all the time, see [Keep it online 24/7](#keep-it-online-247).

The first time the bot reads an image it downloads English language data
(about 10 MB, one time only).

---

## First setup in your server

Type these in Discord. You need the **Manage Server** permission.

1. In a channel only your moderators can see, type `!setlogchannel`.
   The bot will post everything it removes there.
2. Type `!status`. It shows what is switched on and warns you if a permission
   is missing.
3. Optional: `!config add modRoles @Moderators` so that role can use the
   moderation commands.
4. Optional: `!config set eventLogChannel #server-log` to log edits, deletes,
   joins and leaves.
5. Optional: `!postinfo #info` posts a friendly message for your members that
   explains what the bot does.

**Try it out**

- Test a link without posting it for real: `!check https://dlscord.com/gift`
- Teach it a scam image: reply to the image with `!addscam`. Post the same image
  again and the bot deletes it at once.

**Not sure yet?** Type `!config set monitorOnly on`. The bot then only logs what
it *would* do, and deletes or punishes nothing. Switch it off again when you are
happy with it.

---

## How the scam detection works

Scam checks apply to everyone, staff included, because moderator accounts get
hacked too.

1. **Known scam images.** Moderators teach it a scam image once. After that it
   blocks any image that looks close enough, even if it was cropped, resized or
   screenshotted again.
2. **New scam images.** For images it has not seen, it reads the text inside
   (OCR) and scores it for scam words. If it is a scam, the bot removes it and
   remembers it, so reposts are caught instantly.
3. **Known scam links.** About 40,000 phishing sites from two community lists,
   updated every 6 hours, plus the ones you add with `!adddomain`.
4. **Scam links it has never seen**, caught by clues:
   - look-alike addresses: `dlscord.com`, `steamcommunnity.com`, `discord-nitro.ru`
   - look-alike letters: `dіscord.com` written with a Cyrillic *і*
   - disguised links: `[discord.com/gift](https://evil.site)`
   - bait text with an unknown link: "free nitro", "I'm leaving CS, take my skins",
     "connect your wallet"
   - `@everyone` from someone who is not allowed to use it, with scam words and
     an unknown link
5. **Edited messages.** A message is checked again when it is edited.

**When a scam is caught, the bot:**

- deletes it and posts a short notice that removes itself after a few seconds
- deletes that user's other messages from the last 2 minutes
- sends the user a private message that their account may be hacked, with steps
  to secure it
- can also warn, time out, kick, softban or ban them (the `scamAction` setting)
- posts it to the mod log with the image and these buttons:
  **Timeout 1d · Kick · Ban · False positive: forget image**

## AutoMod, warnings and anti-raid

### AutoMod

Staff, exempt roles and exempt channels are skipped.

| Rule | Default | What it does |
| --- | --- | --- |
| `antiDuplicate` | on | The same message 3 times within a minute, in the same or different channels. Every copy is deleted and the user is timed out. |
| `antiSpam` | on | 6 or more messages in 5 seconds |
| `antiMassMention` | on | More than 5 user or role mentions in one message |
| `antiInvites` | on | Invites to *other* servers (invites to your own server are fine) |
| `newMemberLinkMinutes` | 10 | People who joined less than 10 minutes ago cannot post links |
| `antiZalgo` | on | Glitchy "zalgo" text |
| `badWords` | empty | Your own word list. Tricks like `b4dw0rd` and `b a d` are caught too. |
| `antiLinks` | off | Blocks every link except allowed sites |
| `antiCaps` / `antiEmojiSpam` / `antiWallText` | off | Shouting, emoji walls, giant walls of empty lines |

Each hit deletes the message, gives the user a short notice, logs it, and applies
`automodAction` (default: **warn**). One burst only counts once, so five spam
messages do not turn into five warnings.

### Warnings

Warnings from moderators and from AutoMod add up to automatic punishments.
The default is **3 warnings: 1 hour timeout, 5 warnings: 1 day timeout,
7 warnings: kick**. Change it like this:

```
!config set escalation 3=timeout 1h, 5=kick, 8=ban
```

Warnings expire after 30 days (`warnExpiryDays`).

### Anti-raid

Needs the Server Members Intent from step 4.

- **Join flood:** 20 or more joins in 5 seconds switches on *raid mode* for
  15 minutes. Anyone who joins during raid mode gets `raidAction` (default: kick).
- **New accounts:** set `minAccountAgeDays` to act on brand-new accounts when
  they join.
- `!raidmode on/off` switches raid mode by hand. `!lockdown on/off` locks every
  public channel at once, and unlocking puts every channel back exactly as it was.

---

## Commands

Use `!command` or `/command`. `!help` lists the commands you are allowed to use
and `!help <command>` explains one. You can also mention the bot instead of
using the prefix: `@Bot help`.

### Everyone

| Command | What it does |
| --- | --- |
| `!report [reason]` (reply to a message) | Report a message to the moderators. Or right-click the message, then **Apps**, then **Report to mods**. |
| `!help`, `!ping` | Help, and a check that the bot is online |

### Scam detection (Manage Server)

| Command | What it does |
| --- | --- |
| `!addscam [note]` | Add scam images to the blocklist. Attach images, or reply to a message that has them. Or right-click the message, then **Apps**, then **Add as scam image**. |
| `!adddomain <domain> [more...]` | Add scam sites, for example `!adddomain scamsite.net` |
| `!removescam <hash>` | Remove an image from the blocklist |
| `!removedomain <domain>` | Remove a scam site you added |
| `!status` (`!listscam`) | What is switched on in this server, plus a setup check |
| `!setlogchannel [#channel]` | Set the mod log (default: the channel you type it in) |
| `!removelogchannel` | Turn the mod log off |
| `!showlog [n]` | The last `n` removals with thumbnails |
| `!showblockedimages [n]` | The last `n` blocked images with thumbnail, hash and who added them |
| `!check <link or text>` | Test text against the filters and see what the bot thinks of each link. Nothing is deleted. *(Manage Messages)* |

### Moderation

| Command | Needs | What it does |
| --- | --- | --- |
| `!warn @user [reason]` | Timeout Members | Warn. Counts toward automatic punishments, and the user gets a private message. |
| `!timeout @user <10m/2h/1d/1w> [reason]` (`!mute`) | Timeout Members | Time out (28 days at most) |
| `!untimeout @user` (`!unmute`) | Timeout Members | Remove a timeout |
| `!kick @user [reason]` | Kick Members | Kick |
| `!softban @user [reason]` | Ban Members | Kick and remove their last 24 hours of messages. Ideal for hacked accounts. |
| `!ban @user\|ID [reason]` | Ban Members | Ban (also works on users who already left) |
| `!unban <ID> [reason]` | Ban Members | Unban |
| `!note @user <text>` | Timeout Members | Private note in their history |
| `!warnings @user` (`!history`) | Timeout Members | Full moderation history. Or right-click a user, then **Apps**, then **Mod history**. |
| `!clearwarnings @user [case]` | Timeout Members | Clear all warnings, or one |
| `!case <id>` / `!reason <id> <text>` | Timeout Members | Look up or edit a case |
| `!userinfo @user` | Timeout Members | Account age, join date, warnings, removals |
| `!purge <n> [@user] [bots\|links\|images]` | Manage Messages | Delete up to 500 recent messages, with an optional filter |
| `!slowmode <5s/1m/off> [#channel]` | Manage Channels | Slowmode |
| `!lock [#channel]` / `!unlock [#channel]` | Manage Channels | Lock or unlock a channel for @everyone |
| `!lockdown on\|off` | Manage Server | Lock or unlock every public channel |
| `!raidmode on\|off` | Manage Server | Raid mode by hand |

Moderators do not need the Discord permission if they have a role listed in
`modRoles` (`!config add modRoles @Moderators`). For slash commands, also allow
that role under **Server Settings**, **Integrations**, then your bot, because
Discord hides slash commands from members without the default permission.

---

## Settings

### Per server (changed in Discord, Manage Server)

| Command | What it does |
| --- | --- |
| `!config` | Show every setting for this server |
| `!config view <key>` | Explain one setting |
| `!config set <key> <value>` | Change it: `!config set scamAction timeout`, `!config set antiCaps on` |
| `!config add/remove <key> <values>` | Edit lists: `!config add badWords word1 word2`, `!config add allowedDomains mysite.com`, `!config add exemptChannels #memes` |
| `!config reset <key>` | Back to the default |
| `!postinfo [#channel]` | Post a public "This server is protected" message for your members. Run it again to update the same message. |

The main settings:

| Setting | Default | What it is |
| --- | --- | --- |
| `logChannel` / `eventLogChannel` | none | Mod log (removals, cases) and event log (edits, deletes, joins, leaves, bans made outside the bot) |
| `scamAction` | `delete` | Extra punishment for scams: `delete`, `warn`, `timeout`, `kick`, `softban`, `ban` |
| `automodAction` | `warn` | Punishment for AutoMod hits |
| `modRoles`, `exemptRoles`, `exemptChannels` | none | Who counts as a moderator, and what AutoMod ignores |
| `escalation` | `3=timeout 1h, 5=timeout 1d, 7=kick` | Automatic punishments by number of warnings |
| `monitorOnly` | off | Log only, delete nothing |
| `prefix` | `!` | The prefix for text commands |

The full list with defaults is in `SETTINGS_SCHEMA` in [`src/config.js`](src/config.js).

### For the whole bot (`src/config.js`)

These apply to every server your bot is in:

- `matchThreshold`: how alike two images must be (0 = identical, higher = looser). 8 to 12 works well.
- `enableOcr`, `ocrScoreThreshold`, `autoLearnFromOcr`: reading text in images.
- `scamTerms`, `phishingPhrases`, `protectedBrands`: the word lists used for scoring.
- `seedScamDomains`, `allowedDomains`, `phishingFeeds`: known bad sites, always safe sites, and the public lists.
- `creatorName`, `creatorUrl`, `repoUrl`: the credit shown in `!postinfo`.

The image and site blocklists are **shared by all servers** your bot is in.
A scam taught in one server is blocked in all of them.

### Environment variables

Put these in your `.env` file or in your host's settings. Never write them in the code.

| Variable | What it is |
| --- | --- |
| `DISCORD_TOKEN` | Your bot token (required) |
| `BLOCKLIST_PATH` | Where to save data, for example `/app/data/scam-hashes.json`. All other data files are saved next to it. |
| `DEV_GUILD_ID` | Optional. Register slash commands in one server only. They appear at once, which is handy while testing. |
| `OCR_LANG_PATH` | Optional. Folder or URL for `eng.traineddata.gz` if the default download is blocked. |

---

## Keep it online 24/7

The bot only works while it is running. To keep it online, run it on a host.
Any host that runs Node.js works. This is how to do it on Railway:

1. Put your copy of the code in your own GitHub repo.
2. In Railway: **New Project**, then **Deploy from GitHub repo**.
3. Under **Variables** add `DISCORD_TOKEN`.
4. Add a **Volume** and mount it at `/app/data`. Then add the variable
   `BLOCKLIST_PATH=/app/data/scam-hashes.json`. Without a volume the bot forgets
   everything it learned each time it restarts.
5. Watch the deploy logs for `Logged in as ...`.

Reading images uses a few hundred MB of memory while it is busy. On a very small
plan, keep an eye on memory.

**Updating:** download the new code (or `git pull`), run `npm install`, and
start the bot again. Your data files are kept.

---

## Problems and fixes

| Problem | Fix |
| --- | --- |
| `DISCORD_TOKEN is not set` | The `.env` file is missing, has the wrong name, or the token line is empty. See step 6. |
| `Failed to start: Used disallowed intents` | Switch on **Message Content Intent** in the Developer Portal. See step 4. |
| Warning that the Server Members intent is off | The bot still works, but without anti-raid and join logs. Switch on **Server Members Intent** in step 4 to get them. |
| Slash commands do not show up | Wait a few minutes and restart Discord. Make sure you ticked `applications.commands` in step 5. |
| The bot cannot time out or kick someone | Drag the bot's role above that person's role. See step 5. |
| The bot does not delete anything | Type `!status`. It tells you if a permission is missing, or if monitor mode is on. |
| The bot removed something that was fine | Press **False positive: forget image** in the mod log. For a link use `!removedomain site.com`, or allow the site with `!config add allowedDomains site.com`. |
| Reading images does not work | The language data download may be blocked. Set `OCR_LANG_PATH`. The bot keeps running and tries again later. |
| The bot forgets everything after a restart | Your host wipes the files. Add a volume and set `BLOCKLIST_PATH`. See [Keep it online 24/7](#keep-it-online-247). |

Still stuck? Open an issue on the
[Issues page](https://github.com/Smacky89/midoralis-scam-detector/issues).
Never post your token there.

---

## What the bot stores

Everything is saved as files on the machine that runs **your** bot. Nothing is
sent to Midoralis Game Studio or anyone else.

- Fingerprints (hashes) and small thumbnails of blocked scam images
- Scam sites you added, and a cached copy of the public phishing lists
- Each server's settings
- Moderation cases: warnings, timeouts, kicks, bans and notes
- A log of the last 200 removals, with small thumbnails

The bot downloads two public phishing lists from GitHub and, once, the OCR
language data. Those are the only outside connections besides Discord.

---

## For developers

```bash
npm test      # unit tests: detection, automod rules, image hashing
npm run lint  # ESLint with the recommended rules
```

Project layout:

```
index.js               entry point (client, intents, startup and shutdown)
src/config.js          global config and the per-server settings schema
src/store.js           JSON storage (atomic writes), settings, cases
src/phash.js           perceptual hash, thumbnails, OCR preprocessing
src/detect/text.js     link extraction, domain reputation, phishing clues
src/detect/feeds.js    public phishing-domain lists
src/scanner.js         scam pipeline (links, known images, OCR) and actions
src/automod.js         automod rules
src/moderation.js      warn, timeout, kick, ban, cases, escalation
src/raid.js            join-flood detection, raid mode, account-age gate
src/logging.js         mod log and event log posts, case embeds
src/status.js          the !status card and its setup check
src/events.js          Discord event wiring, event log
src/interactions.js    slash commands, context menus, mod-log buttons
src/commands/*.js      command definitions (text and slash from one definition)
src/util.js            small helpers (durations, limiter, timeout, LRU set)
test/*.test.js         unit tests
```

### Contributing

Bug reports and pull requests are welcome. Please run `npm test` and `npm run lint`
before opening a pull request. Never include a bot token, server IDs or your data files
(`scam-hashes.json`, `guilds.json`, `cases.json` and so on) in an issue or commit.

If you find a security problem, please report it privately through the
repository's **Security** tab, with **Report a vulnerability**, and not in a
public issue.

---

## Support the project

The bot is free. If it saved your server from a scam wave and
you want to say thanks, you can
[buy us a coffee](https://buymeacoffee.com/midoralis). Donations are optional and
never unlock anything.

## License

[MIT](LICENSE) © 2026 [Midoralis Game Studio](https://midoralis.com/)
