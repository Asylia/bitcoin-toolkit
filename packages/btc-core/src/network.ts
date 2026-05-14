/**
 * Network selection.
 *
 * Asylia ships mainnet only today. Testnet stays a future toggle so the
 * surrounding code (descriptor builder, address derivation) already takes
 * a `Network` argument and never assumes a single chain.
 *
 * The `Network` shape mirrors `bitcoinjs-lib`'s `networks` object so it can
 * be passed straight into `bitcoin.payments.*` without an adapter.
 */
import { networks } from 'bitcoinjs-lib';

import type { BitcoinNetwork } from './types.ts';

/** Resolve an Asylia network tag onto the corresponding bitcoinjs-lib value. */
export function networkOf(network: BitcoinNetwork) {
  if (network === 'mainnet') return networks.bitcoin;
  // Testnet is intentionally not in the public `BitcoinNetwork` union yet —
  // this branch is here to keep the switch exhaustive for the day the union
  // grows. Until then it is unreachable.
  /* c8 ignore next 2 */
  throw new Error(`Unsupported network: ${network as string}`);
}
