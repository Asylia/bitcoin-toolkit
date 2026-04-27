/**
 * Blockstream.info provider.
 *
 * Talks to the public Esplora deployment at
 * `https://blockstream.info/api`. The free tier accepts anonymous
 * traffic; an enterprise plan replaces it with `clientId` /
 * `clientSecret` Basic auth, which we forward when supplied.
 *
 * In the client-first wallet architecture this provider runs in the
 * browser **without** the paid credentials — those live behind the
 * `EDGE_FALLBACK` provider where they cannot be exfiltrated. The
 * `clientId` / `clientSecret` constructor fields stay supported so
 * a server-side consumer (Edge Function, Node script) can still
 * register an authenticated client when it has access to the secret.
 */
import { EsploraBaseProvider } from './esplora-base';
import { toBase64 } from '../utils';

export interface BlockstreamInfoProviderConfig {
  /** Optional Basic-auth client id (paid tier). */
  clientId?: string;
  /** Optional Basic-auth client secret (paid tier). */
  clientSecret?: string;
  /** When `true` the provider logs every request URL. */
  devMode?: boolean;
}

export class BlockstreamInfoProvider extends EsploraBaseProvider {
  constructor(config: BlockstreamInfoProviderConfig = {}) {
    const headers: Record<string, string> = {};
    if (config.clientId && config.clientSecret) {
      headers['Authorization'] =
        `Basic ${toBase64(`${config.clientId}:${config.clientSecret}`)}`;
    }
    super({
      baseUrl: 'https://blockstream.info/api',
      displayName: 'BLOCKSTREAM_INFO',
      headers,
      ...(config.devMode !== undefined && { devMode: config.devMode }),
    });
  }
}
