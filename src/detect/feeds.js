// Pulls community-maintained phishing domain lists so the bot knows tens of
// thousands of scam domains out of the box. The last good copy is cached on
// disk, so a restart while GitHub is unreachable still has full coverage.
import { CONFIG } from '../config.js';
import { db, FILES, writeJson } from '../store.js';
import { isAllowedDomain } from './text.js';

function parseFeed(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed);
    return Array.isArray(json) ? json : json.domains || [];
  }
  return trimmed.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim());
}

async function refreshPhishingFeeds() {
  if (!CONFIG.phishingFeeds.length) return;
  const next = new Set();
  let ok = 0;
  for (const url of CONFIG.phishingFeeds) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const d of parseFeed(await res.text())) {
        const domain = String(d).toLowerCase().trim();
        // Never let a feed entry block a whole allowed site.
        if (domain.includes('.') && !isAllowedDomain(domain)) next.add(domain);
      }
      ok++;
    } catch (e) {
      console.error(`phishing feed ${url} failed:`, e.message);
    }
  }
  if (ok === 0) return; // keep whatever we had
  db.feedDomains = next;
  await writeJson(FILES.feed, [...next]);
  console.log(`Phishing feeds: ${next.size} domains from ${ok}/${CONFIG.phishingFeeds.length} source(s).`);
}

export function startFeedRefresh() {
  refreshPhishingFeeds();
  const every = CONFIG.phishingFeedRefreshHours * 3_600_000;
  if (every > 0) setInterval(refreshPhishingFeeds, every).unref();
}
