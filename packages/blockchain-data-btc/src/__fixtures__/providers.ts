export const SYNTHETIC_PROVIDER_FIXTURE_NOTICE =
  'Synthetic deterministic provider payloads. Addresses and txids are test-only and not linked to a wallet.';

export const FIXTURE_ADDRESS_A = 'bc1qsyntheticaddress0000000000000000000000000000000';
export const FIXTURE_ADDRESS_B = 'bc1qsyntheticaddress1111111111111111111111111111111';
export const FIXTURE_TXID = '11'.repeat(32);
export const FIXTURE_RAW_TX_HEX = '02000000000100000000000000000000000000000000000000000000000000000000000000000000000000';

export const esploraFixtures = {
  balance: {
    address: FIXTURE_ADDRESS_A,
    chain_stats: {
      funded_txo_sum: 150_000,
      spent_txo_sum: 50_000,
      tx_count: 2,
    },
    mempool_stats: {
      funded_txo_sum: 25_000,
      spent_txo_sum: 0,
      tx_count: 1,
    },
  },
  utxo: {
    txid: FIXTURE_TXID,
    vout: 0,
    value: 100_000,
    status: {
      confirmed: true,
      block_height: 800_000,
      block_hash: '22'.repeat(32),
      block_time: 1_775_000_000,
    },
  },
  transaction: {
    txid: FIXTURE_TXID,
    version: 2,
    locktime: 0,
    vin: [
      {
        txid: '33'.repeat(32),
        vout: 1,
        prevout: {
          scriptpubkey: '0014',
          scriptpubkey_address: FIXTURE_ADDRESS_A,
          value: 150_000,
        },
        sequence: 0xfffffffd,
      },
    ],
    vout: [
      {
        scriptpubkey: '0014',
        scriptpubkey_address: FIXTURE_ADDRESS_B,
        value: 90_000,
      },
    ],
    size: 140,
    weight: 561,
    fee: 10_000,
    status: {
      confirmed: true,
      block_height: 800_001,
      block_time: 1_775_000_600,
    },
  },
};

export const blockchainDotComFixtures = {
  balance: {
    address: FIXTURE_ADDRESS_A,
    final_balance: 100_000,
    total_received: 150_000,
    n_tx: 2,
  },
  unspent: {
    tx_hash_big_endian: FIXTURE_TXID,
    tx_output_n: 0,
    value: 100_000,
    confirmations: 6,
    script: '0020',
  },
};

export const blockcypherFixtures = {
  balance: {
    address: FIXTURE_ADDRESS_A,
    balance: 100_000,
    unconfirmed_balance: 25_000,
    total_received: 150_000,
    n_tx: 2,
    unconfirmed_n_tx: 1,
  },
  utxo: {
    tx_hash: FIXTURE_TXID,
    tx_input_n: -1,
    tx_output_n: 0,
    value: 100_000,
    block_height: 800_000,
  },
};

export const edgeFallbackFixtures = {
  balanceEnvelope: {
    op: 'balance',
    balances: [
      {
        address: FIXTURE_ADDRESS_A,
        balance_sats: 100_000,
        pending_sats: 25_000,
        total_received_sats: 150_000,
        tx_count: 2,
      },
    ],
  },
  utxoEnvelope: {
    op: 'utxos',
    results: [
      {
        address: FIXTURE_ADDRESS_A,
        utxos: [
          {
            txid: FIXTURE_TXID,
            vout: 0,
            valueSats: 100_000,
            address: FIXTURE_ADDRESS_A,
            confirmed: true,
            blockHeight: 800_000,
          },
        ],
      },
    ],
  },
  rawTxEnvelope: {
    op: 'raw-tx',
    txid: FIXTURE_TXID,
    rawTxHex: FIXTURE_RAW_TX_HEX,
  },
  broadcastEnvelope: {
    op: 'broadcast',
    txid: FIXTURE_TXID,
  },
};
