/**
 * Generic Esplora-shaped community mirror provider.
 *
 * Used to plug in independent operators of the same Esplora protocol
 * — `mempool.emzy.de`, `mempool.bisq.services`, `mempool.bitcoin-21.org`,
 * any future deployment a self-hosted user spins up — without
 * subclassing the base provider every time. The mirrors share the
 * exact same wire shape so the only knob is the base URL plus a
 * display label.
 *
 * This is the cheapest way to multiply the available free rate-limit
 * budget: stack four or five mirrors in the priority list and the
 * service walks across them naturally as each one's window fills up.
 */
import { EsploraBaseProvider } from './esplora-base';

export interface EsploraMirrorProviderConfig {
  /** Base URL with no trailing slash. Example: `https://mempool.emzy.de/api`. */
  baseUrl: string;
  /**
   * Display label used in dev-mode logs and the `displayName` slot
   * of the underlying transport. Convention is to mirror the
   * `ProviderId` enum value the consumer registered the mirror under
   * so log lines line up cleanly.
   */
  displayName: string;
  /** When `true` the provider logs every request URL. */
  devMode?: boolean;
}

export class EsploraMirrorProvider extends EsploraBaseProvider {
  constructor(config: EsploraMirrorProviderConfig) {
    super({
      baseUrl: config.baseUrl,
      displayName: config.displayName,
      ...(config.devMode !== undefined && { devMode: config.devMode }),
    });
  }
}
