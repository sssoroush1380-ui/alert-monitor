// Early-warning monitor. Node 18+, no dependencies.
// Env: BOT_TOKEN (bot API token), CHAT_ID (your chat id).
// Optional env: TELEGRAM_CHANNELS (comma-separated, overrides the default list),
//               HEARTBEAT_HOURS (send an "I'm alive" message every N hours; off if unset).
// State (already-seen posts, cooldown, source health) is kept in state.json.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const MIN = 60_000;
const HOUR = 60 * MIN;

// ---------- Tunable config ----------
export const CONFIG = {
  telegramChannels: (process.env.TELEGRAM_CHANNELS || 'VahidOnline')
    .split(',').map((s) => s.trim()).filter(Boolean),
  newsQueries: [
    // [query, hl, gl, ceid]
    ['Iran strike OR strikes OR attack OR explosions when:1h', 'en-US', 'US', 'US:en'],
    ['حمله انفجار ایران when:1h', 'fa', 'IR', 'IR:fa'],
  ],
  tgWindowMin: 90,        // ignore channel posts older than this (dedup is by post id)
  newsWindowMin: 60,      // news items must be this fresh
  newsMinPublishers: 3,   // distinct outlets needed for a multi-source alert
  cooldownMin: 180,       // min gap between multi-source alerts...
  escalationFactor: 2,    // ...unless the outlet count has grown by this factor
  failAlertRuns: 6,       // warn after a source fails this many runs in a row (~30 min)
  fetchTimeoutMs: 15_000,
  seenMax: 1000,
};

const TARGET = /iran|tehran|isfahan|natanz|fordow|tabriz|shiraz|bushehr|kermanshah|ایران|تهران|اصفهان|نطنز|فردو|تبریز|شیراز|بوشهر|کرمانشاه/i;
const ATTACK = /air ?strikes?|\bstrik(e|es|ing)\b|struck|attack(ed|s|ing)?|bomb(ed|s|ing)?|missiles?|drones?|explosions?|blasts?|air defen[cs]e|حمله|حملات|انفجار|موشک|پدافند|بمباران|پهپاد/i;
const ACTOR = /israel|\bidf\b|united states|american|pentagon|اسرائیل|آمریکا|امریکا/i;
const ACTOR_CS = /\bUS\b|\bU\.S\.|\bUSA\b/; // case-sensitive so the pronoun "us" doesn't match

// ---------- Text helpers ----------
const ENTITIES = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&', nbsp: ' ' };

export const strip = (h) =>
  h.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ').trim();

// Arabic yeh/kaf -> Persian, drop zero-width joiners, so Persian keywords match reliably.
export const normalize = (s) =>
  s.replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[‌‍‏]/g, '');

export const isAttack = (s) => { const t = normalize(s); return TARGET.test(t) && ATTACK.test(t); };
export const hasActor = (s) => { const t = normalize(s); return ACTOR.test(t) || ACTOR_CS.test(t); };

// ---------- Parsers ----------
// Public web preview of a channel (the bot API cannot read channels you do not admin).
export function parseChannel(html) {
  return html.split('tgme_widget_message_wrap').slice(1).map((blk) => {
    const id = blk.match(/data-post="([^"]+)"/)?.[1];
    const time = blk.match(/<time[^>]*datetime="([^"]+)"/)?.[1];
    const text = blk.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/)?.[1];
    return id && time && text
      ? { id, ts: Date.parse(time), text: strip(text), url: `https://t.me/${id}` }
      : null;
  }).filter(Boolean);
}

export function parseNews(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const pick = (tag) =>
      (it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '');
    const publisher = strip(pick('source'));
    let title = strip(pick('title'));
    // Google News appends " - Publisher" to titles; drop it so it doesn't skew matching.
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3));
    return { title, link: pick('link').trim(), ts: Date.parse(pick('pubDate')), publisher };
  });
}

// ---------- Network ----------
async function getText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (alert-monitor)' },
    signal: AbortSignal.timeout(CONFIG.fetchTimeoutMs),
  });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}

export function chunk(text, max = 4000) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest);
  return out;
}

async function send(text) {
  const { BOT_TOKEN, CHAT_ID } = process.env;
  for (const part of chunk(text)) {
    for (let attempt = 1; ; attempt++) {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: CHAT_ID, text: part, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(CONFIG.fetchTimeoutMs),
      });
      if (r.ok) break;
      const body = await r.json().catch(() => ({}));
      const retryable = r.status === 429 || r.status >= 500;
      if (!retryable || attempt >= 3) {
        throw new Error(`sendMessage failed: HTTP ${r.status} ${body.description ?? ''}`.trim());
      }
      const wait = (body.parameters?.retry_after ?? 2 ** attempt) * 1000;
      await new Promise((res) => setTimeout(res, Math.min(wait, 30_000)));
    }
  }
}

// ---------- State ----------
function loadState(file) {
  const base = { seen: [], lastNewsAlert: 0, lastNewsCount: 0, failures: {}, lastHeartbeat: 0 };
  if (!fs.existsSync(file)) return { ...base, fresh: true };
  try {
    return { ...base, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    console.error(`state.json unreadable, starting over: ${e.message}`);
    return { ...base, fresh: true };
  }
}

// Track consecutive failures per source; returns messages for sources that just crossed
// the threshold or just recovered.
function trackHealth(state, source, ok, err) {
  const prev = state.failures[source] ?? 0;
  if (ok) {
    delete state.failures[source];
    return prev >= CONFIG.failAlertRuns ? [`RECOVERED: ${source} is reachable again.`] : [];
  }
  state.failures[source] = prev + 1;
  return prev + 1 === CONFIG.failAlertRuns
    ? [`MONITOR PROBLEM: ${source} has failed ${prev + 1} runs in a row.\nLast error: ${err}\nAlerts from this source are not working.`]
    : [];
}

// ---------- Main ----------
export async function run({ now = Date.now(), stateFile = 'state.json' } = {}) {
  const state = loadState(stateFile);
  const seen = new Set(state.seen);
  const alerts = [];
  const health = [];

  // Fetch everything in parallel.
  const [tgResults, newsResults] = await Promise.all([
    Promise.allSettled(CONFIG.telegramChannels.map((ch) => getText(`https://t.me/s/${ch}`))),
    Promise.allSettled(CONFIG.newsQueries.map(([q, hl, gl, ceid]) =>
      getText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`))),
  ]);

  // 1) Telegram channels: fast, single source, unverified
  CONFIG.telegramChannels.forEach((ch, i) => {
    const res = tgResults[i];
    let posts = [];
    if (res.status === 'fulfilled') posts = parseChannel(res.value);
    const ok = res.status === 'fulfilled' && posts.length > 0; // empty = layout changed or blocked
    const err = res.status === 'rejected' ? res.reason?.message : 'no posts parsed (page layout changed?)';
    if (!ok) console.error(`telegram:${ch}: ${err}`);
    health.push(...trackHealth(state, `Telegram channel ${ch}`, ok, err));

    for (const p of posts.sort((a, b) => a.ts - b.ts)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      // On the very first run just record what's there, don't replay old posts.
      if (state.fresh || now - p.ts > CONFIG.tgWindowMin * MIN) continue;
      if (isAttack(p.text)) {
        alerts.push(`WATCH (single source: ${ch}, unverified)\n${p.text.slice(0, 600)}\n${p.url}`);
      }
    }
  });

  // 2) News: needs several independent outlets
  const hits = new Map();
  CONFIG.newsQueries.forEach(([q], i) => {
    const res = newsResults[i];
    const ok = res.status === 'fulfilled';
    if (!ok) console.error(`news "${q}": ${res.reason?.message}`);
    health.push(...trackHealth(state, `Google News query "${q}"`, ok, res.reason?.message));
    if (!ok) return;
    for (const it of parseNews(res.value)) {
      if (now - it.ts < CONFIG.newsWindowMin * MIN && isAttack(it.title) && hasActor(it.title)) {
        const key = (it.publisher || it.link).toLowerCase();
        const prev = hits.get(key);
        if (!prev || it.ts > prev.ts) hits.set(key, it);
      }
    }
  });

  if (hits.size >= CONFIG.newsMinPublishers) {
    const cooledDown = now - state.lastNewsAlert > CONFIG.cooldownMin * MIN;
    const escalated = !cooledDown && state.lastNewsCount > 0 &&
      hits.size >= state.lastNewsCount * CONFIG.escalationFactor;
    if (cooledDown || escalated) {
      const list = [...hits.values()].sort((a, b) => b.ts - a.ts).slice(0, 6)
        .map((i) => `- ${i.publisher || 'unknown'} (${Math.round((now - i.ts) / MIN)} min ago): ${i.title}\n  ${i.link}`)
        .join('\n');
      const head = escalated
        ? `ALERT UPDATE: now ${hits.size} outlets (was ${state.lastNewsCount})`
        : `ALERT: ${hits.size} outlets in the last ${CONFIG.newsWindowMin} min`;
      alerts.push(`${head}\n${list}`);
      state.lastNewsAlert = now;
      state.lastNewsCount = hits.size;
    }
  }

  // 3) Optional heartbeat so you know the monitor is still running.
  const hb = Number(process.env.HEARTBEAT_HOURS);
  if (hb > 0 && now - state.lastHeartbeat > hb * HOUR) {
    const broken = Object.keys(state.failures).filter((s) => state.failures[s] >= CONFIG.failAlertRuns);
    health.push(`Heartbeat: monitor is running. ${broken.length ? `Failing: ${broken.join(', ')}` : 'All sources OK.'}`);
    state.lastHeartbeat = now;
  }

  // Send everything; one failed send must not stop the others or lose state.
  let sendErrors = 0;
  for (const a of [...alerts, ...health]) {
    try { await send(a); } catch (e) { sendErrors++; console.error(e.message); }
  }

  delete state.fresh;
  state.seen = [...seen].slice(-CONFIG.seenMax);
  fs.writeFileSync(stateFile, JSON.stringify(state));
  console.log(`done: ${alerts.length} alert(s), ${health.length} status message(s), ${hits.size} outlet hit(s)`);
  if (sendErrors) throw new Error(`${sendErrors} message(s) could not be sent`);
}

async function main() {
  if (!process.env.BOT_TOKEN || !process.env.CHAT_ID) throw new Error('Set BOT_TOKEN and CHAT_ID');
  if (process.argv.includes('--test')) {
    await send('Test OK: the monitor can reach you.');
    return;
  }
  await run();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
