/**
 * Coin selection helper for `wsh(sortedmulti(...))` Asylia vaults.
 *
 * Implements the simplest defensible algorithm — descending value
 * (largest-first) — which is what Bitcoin Core's `coinselect=largest`
 * mode does and what most multisig wallets (Sparrow, Caravan,
 * Specter) ship as their default. It is not the most fee-efficient
 * (BNB tends to win on average), but it is:
 *
 *   - **Predictable.** The same UTXO set always produces the same
 *     selection, which makes test fixtures and PSBT review surfaces
 *     stable.
 *   - **Easy to audit.** No randomness, no privacy heuristics, no
 *     branch-and-bound recursion — a reviewer can read the loop and
 *     reason about it.
 *   - **Conservative on fees.** Picking the largest UTXOs first
 *     produces the smallest input count, which keeps PSBT vsize
 *     down and minimises the per-byte fee.
 *
 * The algorithm explicitly handles the dust feedback loop: every
 * additional input bumps the fee, which can shrink the change output
 * below the dust threshold. When that happens we drop the change
 * output entirely (folding the change into the fee) rather than
 * producing a transaction the network would reject.
 *
 * It also handles the "send almost everything" edge case where the
 * target amount sits between `inputs - feeWithChange` and
 * `inputs - feeWithoutChange`. With-change is infeasible, but a
 * no-change topology fits — the algorithm tries that path before
 * declaring `INSUFFICIENT_FUNDS`. Without this fallback a vault
 * with a single 10 000 sat UTXO could not spend the result of the
 * "Max" button at the lowest fee tier (10 000 < 9830 + 195, but
 * 10 000 ≥ 9830 + 152).
 */
import type { Utxo } from './types';

/** Default dust threshold in satoshis. Matches Bitcoin Core's policy. */
export const DEFAULT_DUST_THRESHOLD_SATS = 546;

/**
 * vbytes contributed by an empty `wsh(sortedmulti(M, ...))` transaction
 * with N receive/change outputs. Approximation built from the BIP-141
 * weight unit math:
 *
 *   - Tx overhead (version, marker, flag, lock_time, count varints)  ≈ 11 vbytes
 *   - Each P2WSH output (8-byte amount + 34-byte script + length byte) ≈ 43 vbytes
 *   - Each P2WPKH output (8-byte amount + 22-byte script + length byte) ≈ 31 vbytes
 *
 * The default `85` covers Asylia's typical "one external native
 * SegWit recipient + one P2WSH multisig change output" topology.
 * Override `fixedVbytes` for batched sends or non-standard recipient
 * output scripts.
 */
export const DEFAULT_FIXED_VBYTES = 85;

/**
 * vbytes per `wsh(sortedmulti(M, ...))` input. Computed from
 * BIP-141 + BIP-143 witness discount:
 *
 *   - Outpoint + sequence + scriptSig length byte: ~41 bytes (4× weight)
 *   - Witness stack: M signatures (~73 bytes each) + N pubkeys
 *     wrapped in the redeem script (~33 bytes each + opcodes)
 *
 * For the canonical 2-of-3 multisig the value comes out around
 * 110 vbytes per input. Override per-vault when the policy differs.
 */
export const DEFAULT_PER_INPUT_VBYTES = 110;

/**
 * vbytes a single change output adds to the transaction footprint.
 * Used when the algorithm needs to switch from a "with change" to a
 * "no change" topology mid-selection (dust fold or the no-change
 * fallback below). The default value mirrors Asylia's native P2WSH
 * multisig change output (~43 vbytes). Pass an explicit value when
 * using a different change policy.
 */
export const DEFAULT_CHANGE_OUTPUT_VBYTES = 43;

/** Inputs accepted by {@link selectCoinsLargestFirst}. */
export type CoinSelectInput = {
  /** UTXOs available to spend. Order is irrelevant — re-sorted internally. */
  utxos: readonly Utxo[];
  /** Total value the recipient outputs need (sum of recipient amounts). */
  targetSats: number;
  /** Network fee rate the operator picked, in satoshis per vbyte. */
  feeRateSatsPerVByte: number;
  /** Per-input vbyte estimate; defaults to {@link DEFAULT_PER_INPUT_VBYTES}. */
  perInputVbytes?: number;
  /**
   * Fixed transaction overhead in vbytes (header + outputs).
   * Defaults to {@link DEFAULT_FIXED_VBYTES} which assumes one
   * recipient + P2WSH change. Pass a larger value for batched sends.
   */
  fixedVbytes?: number;
  /** Dust threshold in satoshis; defaults to {@link DEFAULT_DUST_THRESHOLD_SATS}. */
  dustThresholdSats?: number;
  /**
   * vbytes a single change output contributes to the transaction.
   * Defaults to {@link DEFAULT_CHANGE_OUTPUT_VBYTES}. The algorithm
   * subtracts this value when it switches to a no-change topology.
   */
  changeOutputVbytes?: number;
};

/** Possible outcomes from {@link selectCoinsLargestFirst}. */
export type CoinSelectResult =
  | {
      ok: true;
      /** UTXOs the caller should spend, in selection order. */
      selected: readonly Utxo[];
      /** Estimated fee in satoshis (`vbytes * feeRate`). */
      feeSats: number;
      /**
       * Change amount in satoshis, or `0` when the spend is exact
       * (selected sum equals `targetSats + feeSats`) or when the
       * remainder fell below the dust threshold and was folded into
       * the fee.
       */
      changeSats: number;
      /** Total vbytes the assembled transaction is expected to consume. */
      vbytes: number;
      /**
       * Positive sub-dust change that was intentionally folded into
       * the network fee instead of becoming an invalid output.
       */
      absorbedDustSats: number;
    }
  | { ok: false; reason: 'EMPTY_UTXOS'; available: 0; required: number }
  | { ok: false; reason: 'INSUFFICIENT_FUNDS'; available: number; required: number };

/**
 * Run the largest-first coin selection.
 *
 * The function is pure — same inputs always yield the same result.
 * Throws no exceptions; failures are surfaced through the
 * discriminated `ok: false` variants of {@link CoinSelectResult}.
 */
export function selectCoinsLargestFirst(
  input: CoinSelectInput,
): CoinSelectResult {
  const {
    utxos,
    targetSats,
    feeRateSatsPerVByte,
    perInputVbytes = DEFAULT_PER_INPUT_VBYTES,
    fixedVbytes = DEFAULT_FIXED_VBYTES,
    dustThresholdSats = DEFAULT_DUST_THRESHOLD_SATS,
    changeOutputVbytes = DEFAULT_CHANGE_OUTPUT_VBYTES,
  } = input;

  if (utxos.length === 0) {
    return { ok: false, reason: 'EMPTY_UTXOS', available: 0, required: targetSats };
  }
  if (targetSats <= 0) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_FUNDS',
      available: 0,
      required: targetSats,
    };
  }

  // Sort descending by value. Stable sort keeps deterministic order
  // among UTXOs of equal value (we tie-break on `txid:vout` for
  // total predictability).
  const sorted = utxos.slice().sort((a, b) => {
    if (b.valueSats !== a.valueSats) return b.valueSats - a.valueSats;
    if (a.txid === b.txid) return a.vout - b.vout;
    return a.txid < b.txid ? -1 : 1;
  });

  const selected: Utxo[] = [];
  let selectedSum = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    selectedSum += utxo.valueSats;

    const vbytes = fixedVbytes + selected.length * perInputVbytes;
    const feeSats = Math.ceil(vbytes * feeRateSatsPerVByte);
    const noChangeVbytes = Math.max(
      vbytes - changeOutputVbytes,
      fixedVbytes - changeOutputVbytes,
    );
    const noChangeFeeMin = Math.ceil(noChangeVbytes * feeRateSatsPerVByte);

    // Preferred path: with-change topology fits in the selected sum.
    if (selectedSum >= targetSats + feeSats) {
      const remainder = selectedSum - targetSats - feeSats;
      // Below dust → fold remainder into the fee, drop the change
      // output. Re-compute vbytes/fee without the change output to
      // surface an honest fee figure to the caller.
      if (remainder < dustThresholdSats) {
        const noChangeFee = selectedSum - targetSats;
        return {
          ok: true,
          selected,
          feeSats: noChangeFee,
          changeSats: 0,
          vbytes: noChangeVbytes,
          absorbedDustSats: Math.max(0, remainder),
        };
      }
      return {
        ok: true,
        selected,
        feeSats,
        changeSats: remainder,
        vbytes,
        absorbedDustSats: 0,
      };
    }

    // Fallback: with-change is infeasible (target + change-output cost
    // exceeds the inputs by a hair), but a no-change topology still
    // fits. Without this branch the operator would hit a misleading
    // "INSUFFICIENT_FUNDS" right at the boundary the "Max" button
    // intentionally targets.
    if (selectedSum >= targetSats + noChangeFeeMin) {
      return {
        ok: true,
        selected,
        // Fold whatever sits between `target` and `selectedSum` into
        // the fee. By construction this is bounded by
        // `changeOutputVbytes * feeRate` sats, so the operator
        // overpays by at most a few sats relative to the minimum.
        feeSats: selectedSum - targetSats,
        changeSats: 0,
        vbytes: noChangeVbytes,
        absorbedDustSats: 0,
      };
    }
  }

  // Walked the entire UTXO set and still cannot cover target + fee.
  const totalAvailable = sorted.reduce((sum, u) => sum + u.valueSats, 0);
  return {
    ok: false,
    reason: 'INSUFFICIENT_FUNDS',
    available: totalAvailable,
    required:
      targetSats +
      Math.ceil((fixedVbytes + sorted.length * perInputVbytes) * feeRateSatsPerVByte),
  };
}

/** Inputs accepted by {@link selectCoinsLargestFirstFixedFee}. */
export type FixedFeeCoinSelectInput = {
  /** UTXOs available to spend. Order is irrelevant — re-sorted internally. */
  utxos: readonly Utxo[];
  /** Total value the recipient outputs need (sum of recipient amounts). */
  targetSats: number;
  /** Exact network fee budget selected by the operator. */
  feeSats: number;
  /** Per-input vbyte estimate; defaults to {@link DEFAULT_PER_INPUT_VBYTES}. */
  perInputVbytes?: number;
  /**
   * Fixed transaction overhead in vbytes (header + outputs).
   * Defaults to {@link DEFAULT_FIXED_VBYTES}, the single-recipient
   * P2WSH-change parameter set.
   */
  fixedVbytes?: number;
  /** Dust threshold in satoshis; defaults to {@link DEFAULT_DUST_THRESHOLD_SATS}. */
  dustThresholdSats?: number;
  /**
   * vbytes a single change output contributes to the transaction.
   * Used only for the returned topology estimate.
   */
  changeOutputVbytes?: number;
};

/** Possible outcomes from {@link selectCoinsLargestFirstFixedFee}. */
export type FixedFeeCoinSelectResult =
  | {
      ok: true;
      selected: readonly Utxo[];
      feeSats: number;
      changeSats: number;
      vbytes: number;
      /**
       * Positive sub-dust change that was intentionally folded into
       * the network fee instead of becoming an invalid output.
       */
      absorbedDustSats: number;
    }
  | {
      ok: false;
      reason: 'EMPTY_UTXOS' | 'INSUFFICIENT_FUNDS';
      available: number;
      required: number;
    };

/**
 * Largest-first selection when the caller supplies an exact network
 * fee budget instead of a sat/vB rate.
 *
 * A sub-dust positive remainder is folded into the fee and surfaced
 * through `absorbedDustSats`, keeping the resulting PSBT valid while
 * letting the wallet UI explain the final fee to the operator.
 */
export function selectCoinsLargestFirstFixedFee(
  input: FixedFeeCoinSelectInput,
): FixedFeeCoinSelectResult {
  const {
    utxos,
    targetSats,
    feeSats,
    perInputVbytes = DEFAULT_PER_INPUT_VBYTES,
    fixedVbytes = DEFAULT_FIXED_VBYTES,
    dustThresholdSats = DEFAULT_DUST_THRESHOLD_SATS,
    changeOutputVbytes = DEFAULT_CHANGE_OUTPUT_VBYTES,
  } = input;

  if (utxos.length === 0) {
    return { ok: false, reason: 'EMPTY_UTXOS', available: 0, required: targetSats };
  }
  if (targetSats <= 0 || feeSats <= 0) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_FUNDS',
      available: 0,
      required: targetSats + feeSats,
    };
  }

  const sorted = utxos.slice().sort((a, b) => {
    if (b.valueSats !== a.valueSats) return b.valueSats - a.valueSats;
    if (a.txid === b.txid) return a.vout - b.vout;
    return a.txid < b.txid ? -1 : 1;
  });

  const selected: Utxo[] = [];
  let selectedSum = 0;

  for (const utxo of sorted) {
    selected.push(utxo);
    selectedSum += utxo.valueSats;
    const changeSats = selectedSum - targetSats - feeSats;
    if (changeSats < 0) continue;

    const withChangeVbytes = fixedVbytes + selected.length * perInputVbytes;
    const noChangeVbytes = Math.max(
      withChangeVbytes - changeOutputVbytes,
      fixedVbytes - changeOutputVbytes,
    );

    if (changeSats === 0) {
      return {
        ok: true,
        selected,
        feeSats,
        changeSats: 0,
        vbytes: noChangeVbytes,
        absorbedDustSats: 0,
      };
    }
    if (changeSats >= dustThresholdSats) {
      return {
        ok: true,
        selected,
        feeSats,
        changeSats,
        vbytes: withChangeVbytes,
        absorbedDustSats: 0,
      };
    }
    return {
      ok: true,
      selected,
      feeSats: feeSats + changeSats,
      changeSats: 0,
      vbytes: noChangeVbytes,
      absorbedDustSats: changeSats,
    };
  }

  const available = sorted.reduce((sum, utxo) => sum + utxo.valueSats, 0);
  return {
    ok: false,
    reason: 'INSUFFICIENT_FUNDS',
    available,
    required: targetSats + feeSats,
  };
}

/** Inputs accepted by {@link maxSpendableSats}. */
export type MaxSpendableInput = {
  /** UTXOs available to spend. Order is irrelevant — re-sorted internally. */
  utxos: readonly Utxo[];
  /** Network fee rate to assume, in satoshis per vbyte. */
  feeRateSatsPerVByte: number;
  /** Per-input vbyte estimate; defaults to {@link DEFAULT_PER_INPUT_VBYTES}. */
  perInputVbytes?: number;
  /**
   * Fixed transaction overhead in vbytes (header + outputs).
   * Defaults to {@link DEFAULT_FIXED_VBYTES}. The helper subtracts
   * `changeOutputVbytes` from this value internally to model the
   * no-change topology a "Max" send always produces.
   */
  fixedVbytes?: number;
  /**
   * vbytes a single change output contributes to the transaction.
   * Defaults to {@link DEFAULT_CHANGE_OUTPUT_VBYTES}.
   */
  changeOutputVbytes?: number;
};

/**
 * Largest single-recipient amount {@link selectCoinsLargestFirst}
 * is guaranteed to accept for the supplied UTXO set + fee rate.
 *
 * Implementation walks every prefix of the descending-value sorted
 * UTXO list, computes the no-change fee for that prefix size, and
 * returns the largest `(prefixSum − fee)` over the walk. This
 * mirrors the inner loop of `selectCoinsLargestFirst` so the
 * "Max" button surfaced to the operator never produces an amount
 * that fails the actual coin-selection downstream.
 *
 * Returns `0` when no positive amount is sendable (empty UTXO set,
 * non-positive fee rate, or fees swallow every prefix).
 */
export function maxSpendableSats(input: MaxSpendableInput): number {
  const {
    utxos,
    feeRateSatsPerVByte,
    perInputVbytes = DEFAULT_PER_INPUT_VBYTES,
    fixedVbytes = DEFAULT_FIXED_VBYTES,
    changeOutputVbytes = DEFAULT_CHANGE_OUTPUT_VBYTES,
  } = input;

  if (utxos.length === 0) return 0;
  if (feeRateSatsPerVByte <= 0) return 0;

  const sorted = utxos.slice().sort((a, b) => b.valueSats - a.valueSats);

  let max = 0;
  let cumulative = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const utxo = sorted[i];
    if (!utxo) continue;
    cumulative += utxo.valueSats;
    const inputCount = i + 1;
    const noChangeVbytes = Math.max(
      fixedVbytes + inputCount * perInputVbytes - changeOutputVbytes,
      fixedVbytes - changeOutputVbytes,
    );
    const fee = Math.ceil(noChangeVbytes * feeRateSatsPerVByte);
    const candidate = cumulative - fee;
    if (candidate > max) max = candidate;
  }

  return Math.max(0, max);
}
