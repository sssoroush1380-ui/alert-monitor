// Early-warning monitor. Node 18+, no dependencies.
// Env: BOT_TOKEN (bot API token), CHAT_ID (your chat id).
// State (already-seen posts, cooldown) is kept in state.json.
import fs from 'node:fs';

const { BOT_TOKEN, CHAT_ID } = process.env;
const STATE_FILE = 'state.json';
const MIN = 60_000;
const now = Date.now();

// ---------- Tunable config ----------
const TELEGRAM_CHANNELS = ['VahidOnline']; // public channels, add more here
const NEWS_QUERIES = [
  // [query, hl, gl, ceid]
  ['Iran strike OR attack OR explosions when:1h', 'en-US', 'US', 'US:en'],
  ['حمله انفجار ایران when:1h', 'fa', 'IR', 'IR:fa'],
];
const TARGET = /iran|tehran|isfahan|natanz|tabriz|shiraz|ایران|تهران|اصفهان|نطنز|تبریز|شیراز/i;
const ATTACK = /airstrike|air strike|strikes? on|struck|attack(ed|s)?|bomb(ed|ing)|missile|explosions?|air defen[cs]e|حمله|حملات|انفجار|موشک|پدافند|بمباران/i;
const ACTOR = /israel|israeli|idf|united states|u\.s\.|\bus\b|american|pentagon|اسرائیل|آمریکا|امریکا/i;
const TG_WINDOW_MIN = 20;       // only consider channel posts this fresh
const NEWS_WINDOW_MIN = 60;     // news items must be this fresh
const NEWS_MIN_PUBLISHERS = 3;  // distinct outlets needed for a multi-source alert
const COOLDOWN_MIN = 180;       // min gap between multi-source alerts

// ---------- Helpers ----------
const state = fs.existsSync(STATE_FILE)
  ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  : { seen: [], lastNewsAlert: 0 };
const seen = new Set(state.seen);

const strip = (h) =>
  h.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (alert-monitor)' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.text();
}

async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`sendMessage failed: HTTP ${r.status}`);
}

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

async function news(q, hl, gl, ceid) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
  const xml = await getText(url);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const pick = (tag) =>
      (it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '');
    return {
      title: strip(pick('title')),
      link: pick('link').trim(),
      ts: Date.parse(pick('pubDate')),
      publisher: strip(pick('source')),
    };
  });
}

// ---------- Main ----------
async function main() {
  if (!BOT_TOKEN || !CHAT_ID) throw new Error('Set BOT_TOKEN and CHAT_ID');
  if (process.argv.includes('--test')) {
    await send('Test OK: the monitor can reach you.');
    return;
  }

  const alerts = [];

  // 1) Telegram channels: fast, single source, unverified
  for (const ch of TELEGRAM_CHANNELS) {
    try {
      for (const p of parseChannel(await getText(`https://t.me/s/${ch}`))) {
        if (seen.has(p.id) || now - p.ts > TG_WINDOW_MIN * MIN) continue;
        seen.add(p.id);
        if (TARGET.test(p.text) && ATTACK.test(p.text)) {
          alerts.push(`WATCH (single source: ${ch}, unverified)\n${p.text.slice(0, 400)}\n${p.url}`);
        }
      }
    } catch (e) { console.error(e.message); }
  }

  // 2) News: needs several independent outlets
  const hits = new Map();
  for (const [q, hl, gl, ceid] of NEWS_QUERIES) {
    try {
      for (const it of await news(q, hl, gl, ceid)) {
        if (now - it.ts < NEWS_WINDOW_MIN * MIN &&
            TARGET.test(it.title) && ATTACK.test(it.title) && ACTOR.test(it.title)) {
          hits.set(it.publisher || it.link, it);
        }
      }
    } catch (e) { console.error(e.message); }
  }
  if (hits.size >= NEWS_MIN_PUBLISHERS && now - state.lastNewsAlert > COOLDOWN_MIN * MIN) {
    const list = [...hits.values()].slice(0, 5)
      .map((i) => `- ${i.publisher}: ${i.title}\n  ${i.link}`).join('\n');
    alerts.push(`ALERT: ${hits.size} outlets in the last ${NEWS_WINDOW_MIN} min\n${list}`);
    state.lastNewsAlert = now;
  }

  for (const a of alerts) await send(a);
  state.seen = [...seen].slice(-500);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  console.log(`done, ${alerts.length} alert(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
