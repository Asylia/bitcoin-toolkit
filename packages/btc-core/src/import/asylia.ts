/**
 * Asylia vault configuration parser.
 *
 * The native Asylia backup is intentionally a redundant wrapper rather
 * than a brand-new wallet grammar. A versioned top-level envelope carries
 * the vault label and then embeds provider payloads that Asylia already
 * understands: Caravan, Sparrow, and a descriptor bundle. Import prefers
 * the structured JSON providers first and falls back to the descriptor
 * provider when needed.
 */
import { parseCaravanWalletConfig } from './caravan';
import { parseDescriptorImport } from './descriptor';
import { parseSparrowWalletConfig } from './sparrow';
import { MultisigImportError } from './types';
import type { ParsedMultisigImport } from './types';

const SUPPORTED_ASYLIA_CONFIG_VERSION = 1;

type JsonObject = Record<string, unknown>;

type AsyliaRawConfig = {
  name?: unknown;
  version?: unknown;
  providers?: unknown;
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function parseVersion(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

function stringifyProvider(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return null;
}

function descriptorTextFromProvider(provider: unknown): string | null {
  if (typeof provider === 'string') return provider;
  const raw = asObject(provider);
  if (!raw) return null;

  const descriptors = [
    asString(raw.descriptor),
    asString(raw.bip389),
    asString(raw.bip389Descriptor),
    asString(raw.receive),
    asString(raw.receiveDescriptor),
    asString(raw.change),
    asString(raw.changeDescriptor),
  ].filter((entry): entry is string => Boolean(entry?.trim()));

  return descriptors.length > 0 ? descriptors.join('\n') : null;
}

/**
 * Parse a versioned Asylia vault config into the same normalised import
 * shape as the provider-specific parsers.
 */
export function parseAsyliaVaultConfig(text: string): ParsedMultisigImport {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new MultisigImportError('Asylia config file is empty.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (cause) {
    throw new MultisigImportError(
      `Asylia config is not valid JSON: ${(cause as Error).message}`,
    );
  }

  const raw = asObject(parsed) as AsyliaRawConfig | undefined;
  if (!raw) {
    throw new MultisigImportError('Asylia config must be a JSON object.');
  }

  const name = asString(raw.name)?.trim();
  if (!name) {
    throw new MultisigImportError('Asylia config is missing the required `name` field.');
  }

  const version = parseVersion(raw.version);
  if (version !== SUPPORTED_ASYLIA_CONFIG_VERSION) {
    throw new MultisigImportError(
      `Asylia config: unsupported \`version\` (${String(raw.version)}). Expected ${SUPPORTED_ASYLIA_CONFIG_VERSION}.`,
    );
  }

  const providers = asObject(raw.providers);
  if (!providers) {
    throw new MultisigImportError('Asylia config is missing the required `providers` object.');
  }

  const errors: string[] = [];

  const caravan = stringifyProvider(providers.caravan);
  if (caravan) {
    try {
      return {
        ...parseCaravanWalletConfig(caravan),
        name,
        source: 'asylia',
      };
    } catch (cause) {
      errors.push(`Caravan provider: ${(cause as Error).message}`);
    }
  }

  const sparrow = stringifyProvider(providers.sparrow);
  if (sparrow) {
    try {
      return {
        ...parseSparrowWalletConfig(sparrow),
        name,
        source: 'asylia',
      };
    } catch (cause) {
      errors.push(`Sparrow provider: ${(cause as Error).message}`);
    }
  }

  const descriptor = descriptorTextFromProvider(providers.descriptor);
  if (descriptor) {
    try {
      return {
        ...parseDescriptorImport(descriptor),
        name,
        source: 'asylia',
      };
    } catch (cause) {
      errors.push(`Descriptor provider: ${(cause as Error).message}`);
    }
  }

  const details = errors.length > 0 ? ` ${errors.join(' ')}` : '';
  throw new MultisigImportError(
    `Asylia config does not contain a valid Caravan, Sparrow, or descriptor provider.${details}`,
  );
}
