import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

/** The live state the dashboard renders; shape matches the UI's normalize(). */
export interface DashboardState {
  price: number;
  index: number;
  tierBps: number;
  tickerCount: number;
  certifiedCount: number;
  tank: { balance: number; reserved: number; withdrawable: number; feeAsset: string; runwayDays: number };
  slots: Array<{
    mine: string;
    tokenId: number;
    slot: number;
    phase: string;
    nextSolveEta: number;
    shiftLen: number;
    prints: number;
    totalPrinted: number;
    justPrinted: number;
    spark: number[];
  }>;
  feed: Array<{ ts: number; key: string; reward: number }>;
  rpc: Array<{ url: string; latencyMs: number; block: number; healthy: boolean }>;
  derpToday: number;
}

const DASHBOARD_URL = new URL('./ui/dashboard.html', import.meta.url);

function pageHtml(): string {
  const body = readFileSync(fileURLToPath(DASHBOARD_URL), 'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>STONKPIT · derpminer</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⛏️</text></svg>">
</head><body style="margin:0;background:#07080a">${body}</body></html>`;
}

/**
 * Serve the live dashboard and its JSON state on localhost. `getState` is
 * called per /api/state request; keep it cheap (the daemon caches live reads).
 */
export function startDashboardServer(port: number, getState: () => Promise<DashboardState>): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url.startsWith('/index')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(pageHtml());
      return;
    }
    if (url.startsWith('/api/state')) {
      getState()
        .then((state) => {
          res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
          res.end(JSON.stringify(state));
        })
        .catch((err) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        });
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.listen(port, '127.0.0.1', () => log.info('dashboard listening', { url: `http://127.0.0.1:${port}` }));
  return server;
}
