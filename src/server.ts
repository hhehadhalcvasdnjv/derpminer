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
const SETUP_URL = new URL('./ui/setup.html', import.meta.url);
const FAVICON =
  "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⛏️</text></svg>\">";

function wrapPage(bodyFile: URL, title: string, head = ''): string {
  const body = readFileSync(fileURLToPath(bodyFile), 'utf8');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>${FAVICON}${head}
</head><body style="margin:0;background:#07080a">${body}</body></html>`;
}

function pageHtml(): string {
  return wrapPage(DASHBOARD_URL, 'STONKPIT · derpminer');
}

/** A transaction the owner signs in their own wallet. */
export interface SigningTx {
  kind: string;
  to: string;
  data: string;
  value: bigint;
  summary: string;
}

export interface SigningChain {
  chainId: number;
  name: string;
  rpc: string;
  explorer: string;
}

/**
 * Serve a one-page wizard that signs the given owner transactions through the
 * user's OWN browser wallet (window.ethereum) — the tool builds the calldata
 * but never sees a key. Resolves `done` when the page reports all signed (or
 * when closed). Binds to 127.0.0.1 only.
 */
export function serveSigningPage(
  port: number,
  title: string,
  chain: SigningChain,
  txs: SigningTx[],
): { server: Server; url: string; done: Promise<void> } {
  const config = JSON.stringify({ title, chain, txs }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const head = `<script>window.__SETUP__ = ${config};</script>`;
  let resolveDone: () => void;
  const done = new Promise<void>((res) => (resolveDone = res));

  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url.startsWith('/setup/done')) {
      res.writeHead(204).end();
      resolveDone();
      return;
    }
    if (url === '/' || url.startsWith('/index')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(wrapPage(SETUP_URL, `${title} · STONKPIT`, head));
      return;
    }
    res.writeHead(404).end('not found');
  });
  server.listen(port, '127.0.0.1', () => log.info('signing page', { url: `http://127.0.0.1:${port}` }));
  return { server, url: `http://127.0.0.1:${port}`, done };
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
