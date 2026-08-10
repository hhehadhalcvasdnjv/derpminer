import { defineChain, type Hex } from 'viem';
import pitMineAbi from './abi/pitMine.json' with { type: 'json' };
import pitBoysMineAbi from './abi/pitBoysMine.json' with { type: 'json' };
import derpAbi from './abi/derp.json' with { type: 'json' };
import erc20Abi from './abi/erc20.json' with { type: 'json' };
import erc721Abi from './abi/erc721.json' with { type: 'json' };

export const ABIS = {
  pitMine: pitMineAbi,
  pitBoysMine: pitBoysMineAbi,
  derp: derpAbi,
  erc20: erc20Abi,
  erc721: erc721Abi,
} as const;

export const OFFICIAL_RPC = 'https://rpc.mainnet.chain.robinhood.com';

/** Robinhood Chain mainnet (Arbitrum-lineage), chainId 4663. */
export const robinhoodChain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [OFFICIAL_RPC] } },
  blockExplorers: {
    default: { name: 'Robinscan', url: 'https://robinscan.io' },
  },
});

export type MineKey = 'broker' | 'pitboys';
export type FeeAsset = 'ETH' | 'APE';

export interface MineProfile {
  key: MineKey;
  /** The mine contract that runs the proof-of-work + reward logic. */
  address: Hex;
  /** The NFT collection whose tokens are the mining bodies. */
  nft: Hex;
  /** How activation/clock-in fees are paid. */
  feeAsset: FeeAsset;
  /** For the APE floor, the ERC20 used for fees and tank (undefined for ETH). */
  feeToken?: Hex;
  /** True when each active slot must be backed by a distinct NFT (PitBoys). */
  bodiesBackSlots: boolean;
  /** The mine's ABI. */
  abi: typeof ABIS.pitMine | typeof ABIS.pitBoysMine;
}

export const DERP: Hex = '0x6543B7746ca744C4bb2198191E71f40FF04C41b9';
export const APE_TOKEN: Hex = '0x8f86a15EC17cb3369d8b3E666dAdBC11daA82b79';

export const MINES: Record<MineKey, MineProfile> = {
  broker: {
    key: 'broker',
    address: '0x2d0da469115232aD00159757f9d25f81D498206D',
    nft: '0x539CdD042c2f3d93EbC5BE7DfFf0c79F3B4fAbF0',
    feeAsset: 'ETH',
    bodiesBackSlots: false,
    abi: ABIS.pitMine,
  },
  pitboys: {
    key: 'pitboys',
    address: '0x6FeD5aE5d486A59081FDC040179CEBDA4be80511',
    nft: '0x57069d845701B50F41327362C1C23789043F8DEc',
    feeAsset: 'APE',
    feeToken: APE_TOKEN,
    bodiesBackSlots: true,
    abi: ABIS.pitBoysMine,
  },
};

/** Max mining slots per token (contract MAX_SLOTS). */
export const MAX_SLOTS = 16;
