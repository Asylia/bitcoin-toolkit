/**
 * Public types for `@asylia/btc-core`.
 *
 * Kept narrow on purpose: every field maps onto a real concept from
 * BIP-32 / BIP-48 / BIP-380 so reviewers can audit the API surface
 * against the specifications without translating Asylia-specific
 * naming.
 */

/**
 * Bitcoin network tag. Mainnet only today; testnet stays a future toggle
 * so callers already pass the value through every API.
 */
export type BitcoinNetwork = 'mainnet';

/**
 * Locked output script policy. Asylia targets native-SegWit P2WSH multisig
 * (`wsh(sortedmulti(...))`) at BIP-48 `script_type = 2'`. There is no
 * other variant on the roadmap.
 */
export type ScriptPolicy = 'wsh-sortedmulti';

/**
 * One descriptor key — the registered xpub plus the BIP-380 key-origin
 * block (`[fingerprint/path]xpub`). The xpub stored in the database is
 * the value the device exported for the multisig branch; descendants are
 * derived client-side from `chain/index`.
 */
export type DescriptorKey = {
  /** BIP-32 master key fingerprint (8 lowercase hex characters). */
  fingerprint: string;
  /**
   * BIP-32 derivation path of the exported xpub, *without* the leading
   * `m/`. BIP-380 key-origin blocks expect the path in this form, so the
   * builder does not have to strip the prefix at every call site.
   *
   * Example: `48'/0'/0'/2'`. Both `'` and `h` notations are accepted.
   */
  derivationPath: string;
  /**
   * BIP-32 base58check-encoded extended public key at `derivationPath`.
   * The body must be a universal `xpub` form; SLIP-132 prefixes (Zpub,
   * zpub, Ypub, …) are accepted but normalised to `xpub` before being
   * embedded so the descriptor stays canonical.
   */
  xpub: string;
};

/** Inputs accepted by {@link buildWshSortedMultiDescriptor}. */
export type BuildWshSortedMultiInput = {
  /** Threshold (`N` in `N-of-T`). */
  requiredSignatures: number;
  /** Cosigning keys. The descriptor assembles them in the supplied order. */
  keys: readonly DescriptorKey[];
  /** Mainnet for now. Future-proofing the API. */
  network: BitcoinNetwork;
};

/**
 * Output of {@link buildWshSortedMultiDescriptor}.
 *
 * Three descriptor strings are returned for convenience:
 *
 * - `descriptor` — modern unified form using `<0;1>/*` (BIP-389) so a
 *   single descriptor covers both the receive (chain `0`) and change
 *   (chain `1`) branches. This is the canonical value Asylia stores.
 * - `receiveDescriptor` / `changeDescriptor` — the same multisig with
 *   the chain index split out (`/0/*` or `/1/*`). They are useful for
 *   tools that don't yet understand BIP-389 (older Sparrow versions,
 *   Caravan, server-side scanners).
 *
 * Each string ends with a `#checksum` suffix (BIP-380) so the value can
 * be exported as-is.
 */
export type BuildWshSortedMultiResult = {
  descriptor: string;
  receiveDescriptor: string;
  changeDescriptor: string;
};

/** Inputs accepted by {@link deriveWshSortedMultiAddress}. */
export type DeriveWshSortedMultiAddressInput = {
  requiredSignatures: number;
  keys: readonly DescriptorKey[];
  network: BitcoinNetwork;
  /** `0` for receive, `1` for change. */
  chain: 0 | 1;
  /** Sequential address index. Negative values are rejected. */
  index: number;
};

/**
 * Inputs accepted by `deriveWshSortedMultiAddressBatch`.
 *
 * Derives a contiguous range of addresses on one chain in one call so
 * the consumer (typically a balance / gap-limit walker) does not have
 * to reconstruct BIP-32 nodes once per index. The xpub → BIP-32 node
 * conversion happens once per cosigner; the per-index work is reduced
 * to a `node.derive(chain).derive(index)` step plus the on-chain
 * `p2ms` + `p2wsh` assembly.
 *
 * `count` is intentionally finite (`> 0`, integer) so callers cannot
 * accidentally request "all addresses" — the typical use is a 20-slot
 * BIP-44 gap-limit window per chain.
 */
export type DeriveWshSortedMultiAddressBatchInput = {
  requiredSignatures: number;
  keys: readonly DescriptorKey[];
  network: BitcoinNetwork;
  /** `0` for receive, `1` for change. */
  chain: 0 | 1;
  /** First address index, inclusive. Negative values are rejected. */
  startIndex: number;
  /** Number of addresses to derive. Must be a positive integer. */
  count: number;
};

/**
 * One entry in a {@link deriveWshSortedMultiAddressBatch} result. The
 * shape mirrors the row a downstream consumer wants to persist or
 * forward to a balance provider — the bech32 `address` is the only
 * value the provider needs, but `chain` and `index` make it cheap to
 * map the result back onto the originating BIP-32 slot without keeping
 * a parallel array.
 */
export type WshSortedMultiAddressEntry = {
  /** `0` for receive, `1` for change. Echo of the input. */
  chain: 0 | 1;
  /** BIP-32 address index on the supplied chain. */
  index: number;
  /** Native-SegWit P2WSH bech32 address (`bc1q…`). */
  address: string;
};
