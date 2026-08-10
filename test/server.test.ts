import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { startDashboardServer, serveSigningPage, type DashboardState } from '../src/server.js';

const SAMPLE: DashboardState = {
  price: 0.000895,
  index: 90,
  tierBps: 10000,
  tickerCount: 2137251,
  certifiedCount: 34427,
  tank: { balance: 12.4, reserved: 8.1, withdrawable: 4.3, feeAsset: 'APE', runwayDays: 1.3 },
  slots: [
    { mine: 'pitboys', tokenId: 742, slot: 0, phase: 'GRINDING', nextSolveEta: 420, shiftLen: 839, prints: 8, totalPrinted: 331, justPrinted: 0, spark: [44, 120] },
  ],
  feed: [{ ts: 1, key: '#742·0', reward: 52 }],
  rpc: [{ url: 'https://rpc.mainnet.chain.robinhood.com', latencyMs: 78, block: 32891233, healthy: true }],
  derpToday: 1094,
};

let server: Server | undefined;
const PORT = 8799;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function get(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return { status: res.status, body: await res.text() };
}

describe('dashboard server', () => {
  it('serves the dashboard HTML at /', async () => {
    server = startDashboardServer(PORT, async () => SAMPLE);
    await new Promise((r) => setTimeout(r, 100));
    const { status, body } = await get('/');
    expect(status).toBe(200);
    expect(body).toContain('<!doctype html>');
    expect(body).toContain('STONKPIT'); // the dashboard markup is inlined
    expect(body).toContain('/api/state'); // the poll target
  });

  it('serves live state as JSON at /api/state', async () => {
    server = startDashboardServer(PORT, async () => SAMPLE);
    await new Promise((r) => setTimeout(r, 100));
    const { status, body } = await get('/api/state');
    expect(status).toBe(200);
    const json = JSON.parse(body) as DashboardState;
    expect(json.index).toBe(90);
    expect(json.slots).toHaveLength(1);
    expect(json.slots[0].tokenId).toBe(742);
    expect(json.rpc[0].healthy).toBe(true);
  });

  it('calls getState fresh on each request', async () => {
    let n = 0;
    server = startDashboardServer(PORT, async () => ({ ...SAMPLE, derpToday: ++n }));
    await new Promise((r) => setTimeout(r, 100));
    const a = JSON.parse((await get('/api/state')).body) as DashboardState;
    const b = JSON.parse((await get('/api/state')).body) as DashboardState;
    expect(b.derpToday).toBeGreaterThan(a.derpToday);
  });

  it('404s unknown paths', async () => {
    server = startDashboardServer(PORT, async () => SAMPLE);
    await new Promise((r) => setTimeout(r, 100));
    expect((await get('/nope')).status).toBe(404);
  });
});

describe('signing page', () => {
  const chain = { chainId: 4663, name: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinscan.io' };
  const txs = [
    { kind: 'agree', to: '0x6FeD5aE5d486A59081FDC040179CEBDA4be80511', data: '0x8fae60a5', value: 0n, summary: 'Agree.' },
    { kind: 'depositTank', to: '0x6FeD5aE5d486A59081FDC040179CEBDA4be80511', data: '0x1234', value: 15_000000000000000000n, summary: 'Fund.' },
  ];

  it('injects the txs as window.__SETUP__ (bigints as strings) and serves the page', async () => {
    const s = serveSigningPage(PORT + 1, 'Shadow-key setup', chain, txs);
    server = s.server;
    await new Promise((r) => setTimeout(r, 100));
    const res = await fetch(`http://127.0.0.1:${PORT + 1}/`);
    const body = await res.text();
    expect(body).toContain('window.__SETUP__');
    expect(body).toContain('"chainId":4663');
    expect(body).toContain('"15000000000000000000"'); // bigint value serialized as string
    expect(body).toContain('STONKPIT'); // the setup UI markup is inlined
  });

  it('resolves done when the page POSTs /setup/done', async () => {
    const s = serveSigningPage(PORT + 2, 'Setup', chain, txs);
    server = s.server;
    await new Promise((r) => setTimeout(r, 100));
    let resolved = false;
    void s.done.then(() => (resolved = true));
    await fetch(`http://127.0.0.1:${PORT + 2}/setup/done`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(true);
  });
});
