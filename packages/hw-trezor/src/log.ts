/**
 * Production-safe structured logger for the Trezor adapter.
 *
 * Hardware-wallet logs cross a sensitive boundary: descriptors, xpubs,
 * PSBTs, txids, addresses, fingerprints, raw SDK payloads, HMACs, and
 * device identifiers must never reach the console in full. Routine info
 * logs are debug-gated; warnings and errors remain visible with redacted
 * context so support still gets stable codes, counts, booleans, and phases.
 */

const PREFIX = '[hw-trezor]';
const REDACTED = '[redacted]';
const REDACTED_DEPTH = '[redacted:depth]';
const MAX_DEPTH = 5;

const EXTENDED_PUBLIC_KEY_PATTERN = /\b(?:[xyzuvXYZUV]pub)[1-9A-HJ-NP-Za-km-z]{20,}\b/g;
const PSBT_PATTERN = /\bcHNidP[A-Za-z0-9+/=]{20,}\b/g;
const TXID_PATTERN = /\b[0-9a-fA-F]{64}\b/g;
const ADDRESS_PATTERN = /\b(?:bc1[ac-hj-np-z02-9]{20,}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g;
const FINGERPRINT_CONTEXT_PATTERN =
  /\b(fingerprint|masterFingerprint|xfp)(\s*[:=]\s*)[0-9a-fA-F]{8}\b/gi;
const DESCRIPTOR_PATTERN = /\b(?:wsh|sh|tr)\([^)]*(?:sortedmulti|multi)[\s\S]*\)/i;
const SENSITIVE_KEY_PATTERN =
  /(address|cause|descriptor|device.*id|error|extended.*public.*key|features|fingerprint|hmac|manifest|message|name|payload|policy|psbt|public.*key|raw|response|serial|stack|statusText|txid|xpub|ypub|zpub|tpub|upub|vpub|xfp)/i;
const STABLE_STRING_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const SAFE_SUMMARY_KEYS = new Set([
  'success',
  'code',
  'phase',
  'status',
  'statusCode',
  'transportType',
  'transportVersion',
  'type',
]);

export type LogContext = Record<string, unknown>;

type GlobalWithProcess = typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
};

function redactString(value: string): string {
  if (DESCRIPTOR_PATTERN.test(value)) return '[redacted:descriptor]';
  return value
    .replace(EXTENDED_PUBLIC_KEY_PATTERN, '[redacted:xpub]')
    .replace(PSBT_PATTERN, '[redacted:psbt]')
    .replace(TXID_PATTERN, '[redacted:txid]')
    .replace(ADDRESS_PATTERN, '[redacted:address]')
    .replace(FINGERPRINT_CONTEXT_PATTERN, `$1$2${REDACTED}`);
}

function summariseStableValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return STABLE_STRING_PATTERN.test(value) ? value : REDACTED;
  }
  return value;
}

function summariseSensitiveObject(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    if (typeof value !== 'string') return REDACTED;
    const redacted = redactString(value);
    return redacted === value ? REDACTED : redacted;
  }

  if (value instanceof Error) {
    return { redacted: true };
  }

  const input = value as Record<string, unknown>;
  const summary: Record<string, unknown> = { redacted: true };
  for (const key of SAFE_SUMMARY_KEYS) {
    if (key in input) {
      const item = input[key];
      summary[key] = summariseStableValue(item);
    }
  }
  return summary;
}

function redactValue(value: unknown, key = '', depth = 0, seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return summariseSensitiveObject(value);
  if (typeof value === 'string') {
    const redacted = redactString(value);
    if (redacted !== value) return redacted;
    if (SAFE_SUMMARY_KEYS.has(key)) return summariseStableValue(value);
    return REDACTED;
  }
  if (typeof value !== 'object' || value === null) return value;
  if (value instanceof Error) return { redacted: true };
  if (seen.has(value)) return '[redacted:circular]';
  if (depth >= MAX_DEPTH) return REDACTED_DEPTH;

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, '', depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    out[entryKey] = redactValue(entryValue, entryKey, depth + 1, seen);
  }
  return out;
}

export function redactLogContext(context: LogContext): LogContext {
  return redactValue(context) as LogContext;
}

export function isHardwareDebugLoggingEnabled(): boolean {
  const env = (globalThis as GlobalWithProcess).process?.env;
  if (env?.ASYLIA_HW_DEBUG === '1' || env?.ASYLIA_HW_DEBUG === 'true') return true;

  try {
    return globalThis.localStorage?.getItem('asylia.hardware.debug') === '1';
  } catch {
    return false;
  }
}

function write(
  level: 'info' | 'warn' | 'error',
  event: string,
  context?: LogContext,
): void {
  if (level === 'info' && !isHardwareDebugLoggingEnabled()) return;
  const message = `${PREFIX} ${event}`;
  if (context) {
    console[level](message, redactLogContext(context));
  } else {
    console[level](message);
  }
}

export const log = {
  info(event: string, context?: LogContext): void {
    write('info', event, context);
  },
  warn(event: string, context?: LogContext): void {
    write('warn', event, context);
  },
  error(event: string, context?: LogContext): void {
    write('error', event, context);
  },
};
