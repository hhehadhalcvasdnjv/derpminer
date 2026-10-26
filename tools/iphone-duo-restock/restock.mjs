#!/usr/bin/env node
// iPhone Duo restock bot: watches Apple Store pickup availability in Munich and
// pushes an alert (ntfy and/or Telegram) the moment a matching variant appears.
// It only notifies; ordering is left to you in the Apple Store app.
//
//   node --env-file=.env restock.mjs           run forever
//   node --env-file=.env restock.mjs --once    one check, print the table
//   node --env-file=.env restock.mjs --test    send a test notification

import { parseProducts, filterByCapacity, fulfillmentUrl, parseAvailability, newlyAvailable, chunk } from './lib.mjs';

const env = process.env;
const cfg = {
  productUrl: env.PRODUCT_URL || 'https://www.apple.com/de/shop/buy-iphone/iphone-duo',
  location: env.LOCATION || '80331',
  storeMatch: env.STORE_MATCH ?? 'München',
  capacities: (env.CAPACITIES || '256,512').split(',').map((s) => Number(s.trim())).filter(Boolean),
  parts: (env.PARTS || '').split(',').map((s) => s.trim()).filter(Boolean),
  intervalSec: Math.max(30, Number(env.INTERVAL_SEC || 90)),
  // 0 = run forever. Set for schedulers (GitHub Actions) that start a fresh run periodically.
  maxRuntimeSec: Number(env.MAX_RUNTIME_SEC || 0),
  ntfyServer: (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, ''),
  ntfyTopic: env.NTFY_TOPIC || '',
  tgToken: env.TELEGRAM_BOT_TOKEN || '',
  tgChat: env.TELEGRAM_CHAT_ID || '',
};

const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'accept-language': 'de-DE,de;q=0.9,en;q=0.6',
};
const REDISCOVER_MS = 6 * 60 * 60 * 1000;
const MAX_BACKOFF_SEC = 15 * 60;

const ts = () => new Date().toLocaleTimeString('de-DE');
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} für ${url}`);
    this.status = status;
  }
}

async function get(url, accept) {
  const res = await fetch(url, { headers: { ...HEADERS, accept, referer: cfg.productUrl } });
  if (!res.ok) throw new HttpError(res.status, url);
  return res;
}

/** Variants to watch: PARTS if set, otherwise everything on the product page with a wanted capacity. */
async function discoverParts() {
  if (cfg.parts.length) return cfg.parts.map((part) => ({ part, capacityGb: null, color: null }));
  const html = await (await get(cfg.productUrl, 'text/html')).text();
  const all = parseProducts(html);
  const wanted = filterByCapacity(all, cfg.capacities);
  if (!wanted.length) {
    throw new Error(
      `Keine Varianten mit ${cfg.capacities.join('/')} GB auf ${cfg.productUrl} gefunden ` +
        `(${all.length} Teilenummern insgesamt). Prüf PRODUCT_URL oder setz PARTS manuell.`,
    );
  }
  return wanted;
}

async function checkStock(parts) {
  const rows = [];
  // Apple's own page asks for a handful of parts at once; stay in that range.
  for (const group of chunk(parts.map((p) => p.part), 8)) {
    const res = await get(fulfillmentUrl(cfg.productUrl, group, cfg.location), 'application/json');
    rows.push(...parseAvailability(await res.json(), cfg.storeMatch));
  }
  return rows;
}

async function notify(title, message) {
  const jobs = [];
  if (cfg.ntfyTopic) {
    jobs.push(
      fetch(cfg.ntfyServer, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: cfg.ntfyTopic, title, message, priority: 5, tags: ['iphone', 'rotating_light'], click: cfg.productUrl }),
      }),
    );
  }
  if (cfg.tgToken && cfg.tgChat) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.tgChat, text: `${title}\n\n${message}\n\n${cfg.productUrl}` }),
      }),
    );
  }
  if (!jobs.length) log('⚠️  Kein NTFY_TOPIC / TELEGRAM_* gesetzt, Alarm nur in der Konsole.');
  // A broken notifier must never stop the watch loop.
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === 'rejected') log('Benachrichtigung fehlgeschlagen:', String(r.reason));
    else if (!r.value.ok) log('Benachrichtigung fehlgeschlagen: HTTP', r.value.status);
  }
}

function printTable(rows) {
  if (!rows.length) return log(`Keine Filiale passend zu "${cfg.storeMatch}" in der Antwort.`);
  for (const r of rows) log(`${r.available ? '✅' : '❌'} ${r.store.padEnd(14)} ${r.title}  ${r.quote}`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--test')) {
    await notify('🧪 Test vom iPhone-Duo-Bot', 'Wenn du das liest, kommen die Alarme an.');
    return log('Testnachricht verschickt.');
  }

  let parts = await discoverParts();
  let discoveredAt = Date.now();
  log(`Überwache ${parts.length} Variante(n) in "${cfg.storeMatch}" (PLZ ${cfg.location}):`);
  for (const p of parts) log(`   ${p.part}  ${p.capacityGb ?? '?'} GB  ${p.color ?? ''}`);

  if (args.has('--once')) return printTable(await checkStock(parts));

  const stopAt = cfg.maxRuntimeSec ? Date.now() + cfg.maxRuntimeSec * 1000 : Infinity;
  let prev = new Set();
  let backoff = 0;
  let okChecks = 0;
  while (Date.now() < stopAt) {
    try {
      if (Date.now() - discoveredAt > REDISCOVER_MS) {
        parts = await discoverParts();
        discoveredAt = Date.now();
      }
      const rows = await checkStock(parts);
      const { fresh, keys } = newlyAvailable(prev, rows);
      prev = keys;
      backoff = 0;
      okChecks++;
      if (fresh.length) {
        const lines = fresh.map((r) => `• ${r.title}: ${r.store} ${r.quote}`.trim());
        log('🚨 VERFÜGBAR\n' + lines.join('\n'));
        await notify('🚨 iPhone Duo abholbereit in München!', lines.join('\n') + '\n\nJetzt in der Apple Store App bestellen und Abholung wählen.');
      } else {
        log(`${keys.size ? `${keys.size} weiterhin verfügbar` : 'nichts frei'} (${rows.length} Kombinationen geprüft)`);
      }
    } catch (err) {
      // 403/429/503/541 = Apple bremst uns; dann länger warten statt weiter zu hämmern.
      backoff = Math.min(MAX_BACKOFF_SEC, backoff ? backoff * 2 : 120);
      log(`Fehler: ${err.message}. Nächster Versuch in ${backoff}s.`);
    }
    const base = backoff || cfg.intervalSec;
    const wait = base * 1000 * (0.8 + Math.random() * 0.4);
    if (Date.now() + wait >= stopAt) break;
    await sleep(wait);
  }
  log('Maximale Laufzeit erreicht, beende.');
  // A run where Apple answered nothing must show up red, not as a silent green run.
  if (!okChecks) {
    log('Keine einzige Abfrage erfolgreich.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  log('Abbruch:', err.message);
  process.exit(1);
});
