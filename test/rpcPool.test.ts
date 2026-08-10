import { describe, it, expect, vi } from 'vitest';
import { custom, type Hex } from 'viem';
import { RpcPool, type Endpoint } from '../src/chain/rpcPool.js';

/** Build an Endpoint whose transport dispatches on JSON-RPC method. */
function fakeEndpoint(url: string, handler: (method: string, params: unknown) => Promise<unknown>): Endpoint {
  return {
    url,
    transport: custom({
      request: async ({ method, params }: { method: string; params: unknown }) => handler(method, params),
    }),
  };
}

describe('RpcPool.read', () => {
  it('fails over to a healthy endpoint when one errors', async () => {
    const bad = vi.fn(async () => {
      throw new Error('boom');
    });
    const good = vi.fn(async (method: string) => {
      if (method === 'eth_blockNumber') return '0x10'; // 16
      return '0x0';
    });
    const pool = new RpcPool([fakeEndpoint('bad', bad), fakeEndpoint('good', good)]);
    const bn = await pool.read((c) => c.getBlockNumber());
    expect(bn).toBe(16n);
    expect(good).toHaveBeenCalled();
  });

  it('throws when every endpoint fails', async () => {
    const err = async () => {
      throw new Error('down');
    };
    const pool = new RpcPool([fakeEndpoint('a', err), fakeEndpoint('b', err)]);
    await expect(pool.read((c) => c.getBlockNumber())).rejects.toThrow(/all RPC endpoints failed/);
  });
});

describe('RpcPool.probe + health', () => {
  it('demotes a lagging endpoint so reads route to the fresh one', async () => {
    // Each endpoint reports its own block on eth_blockNumber. If the laggy one
    // (block 1) were chosen, the read would return 1; the fresh one returns 256.
    const laggy = fakeEndpoint('laggy', async (m) => (m === 'eth_blockNumber' ? '0x1' : '0x0'));
    const fresh = fakeEndpoint('fresh', async (m) => (m === 'eth_blockNumber' ? '0x100' : '0x0'));
    const pool = new RpcPool([laggy, fresh], undefined, { maxLagBlocks: 5n });
    await pool.probe();
    const val = await pool.read((c) => c.getBlockNumber());
    expect(val).toBe(256n); // read went to fresh, not laggy
    const status = pool.status();
    expect(status.find((s) => s.url === 'laggy')!.block).toBe(1n);
    expect(status.find((s) => s.url === 'fresh')!.block).toBe(256n);
  });
});

describe('RpcPool.hedgedSend', () => {
  it('broadcasts raw tx to all healthy endpoints and returns the hash', async () => {
    const seen: string[] = [];
    const mk = (url: string) =>
      fakeEndpoint(url, async (method: string) => {
        if (method === 'eth_sendRawTransaction') {
          seen.push(url);
          return '0xhash';
        }
        return '0x1';
      });
    const pool = new RpcPool([mk('a'), mk('b')]);
    const hash = await pool.hedgedSend('0xdeadbeef' as Hex);
    expect(hash).toBe('0xhash');
    // give the other in-flight broadcast a tick to land
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.sort()).toEqual(['a', 'b']);
  });

  it('treats "already known" as success and still returns a hash', async () => {
    const a = fakeEndpoint('a', async (m) => {
      if (m === 'eth_sendRawTransaction') throw new Error('already known');
      return '0x1';
    });
    const b = fakeEndpoint('b', async (m) => {
      if (m === 'eth_sendRawTransaction') throw new Error('already known');
      return '0x1';
    });
    const pool = new RpcPool([a, b]);
    const hash = await pool.hedgedSend('0xdeadbeef' as Hex);
    // keccak256 of the raw tx — deterministic, non-null.
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rejects when all endpoints fail with real errors', async () => {
    const err = fakeEndpoint('a', async (m) => {
      if (m === 'eth_sendRawTransaction') throw new Error('execution reverted');
      return '0x1';
    });
    const pool = new RpcPool([err]);
    await expect(pool.hedgedSend('0xdeadbeef' as Hex)).rejects.toThrow(/hedged send failed/);
  });
});
