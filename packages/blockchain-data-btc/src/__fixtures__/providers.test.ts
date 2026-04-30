import { describe, expect, it } from 'vitest';

import { mapBlockchainDotCom, mapBlockchainDotComUnspent } from '../mappers/blockchain-com';
import { mapBlockcypherBalance, mapBlockcypherUtxo } from '../mappers/blockcypher';
import { mapEsploraAddress, mapEsploraTransaction, mapEsploraUtxo } from '../mappers/esplora';
import {
  blockchainDotComFixtures,
  blockcypherFixtures,
  edgeFallbackFixtures,
  esploraFixtures,
  FIXTURE_ADDRESS_A,
  FIXTURE_RAW_TX_HEX,
  FIXTURE_TXID,
  SYNTHETIC_PROVIDER_FIXTURE_NOTICE,
} from './providers';

describe('synthetic provider fixtures', () => {
  it('keeps canonical provider payloads small, synthetic, and mapper-compatible', () => {
    expect(SYNTHETIC_PROVIDER_FIXTURE_NOTICE).toContain('Synthetic deterministic');
    expect(FIXTURE_TXID).toMatch(/^[0-9a-f]{64}$/);
    expect(FIXTURE_RAW_TX_HEX).toMatch(/^(?:[0-9a-f]{2})+$/);

    expect(mapEsploraAddress(esploraFixtures.balance)).toMatchObject({
      address: FIXTURE_ADDRESS_A,
      balance_sats: 100_000,
      pending_sats: 25_000,
    });
    expect(mapEsploraUtxo(FIXTURE_ADDRESS_A, esploraFixtures.utxo)).toMatchObject({
      txid: FIXTURE_TXID,
      address: FIXTURE_ADDRESS_A,
    });
    expect(mapEsploraTransaction(esploraFixtures.transaction)).toMatchObject({
      txid: FIXTURE_TXID,
      feeSats: 10_000,
    });
    expect(mapBlockchainDotCom(blockchainDotComFixtures.balance)).toMatchObject({
      address: FIXTURE_ADDRESS_A,
      balance_sats: 100_000,
    });
    expect(mapBlockchainDotComUnspent(FIXTURE_ADDRESS_A, blockchainDotComFixtures.unspent))
      .toMatchObject({ txid: FIXTURE_TXID });
    expect(mapBlockcypherBalance(blockcypherFixtures.balance)).toMatchObject({
      pending_sats: 25_000,
    });
    expect(mapBlockcypherUtxo(FIXTURE_ADDRESS_A, blockcypherFixtures.utxo, true))
      .toMatchObject({ txid: FIXTURE_TXID });
    expect(edgeFallbackFixtures.broadcastEnvelope).toEqual({
      op: 'broadcast',
      txid: FIXTURE_TXID,
    });
  });
});
