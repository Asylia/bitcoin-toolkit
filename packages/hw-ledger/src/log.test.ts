import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isHardwareDebugLoggingEnabled, log, redactLogContext } from './log';

type GlobalWithProcess = typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
};

const XPUB = `xpub${'A'.repeat(80)}`;
const PSBT = `cHNidP${'A'.repeat(80)}`;
const TXID = 'ab'.repeat(32);
const ADDRESS = `bc1q${'a'.repeat(38)}`;

describe('Ledger hardware logger', () => {
  let originalDebugEnv: string | undefined;

  beforeEach(() => {
    originalDebugEnv = (globalThis as GlobalWithProcess).process?.env?.ASYLIA_HW_DEBUG;
    if ((globalThis as GlobalWithProcess).process?.env) {
      (globalThis as GlobalWithProcess).process!.env!.ASYLIA_HW_DEBUG = undefined;
    }
  });

  afterEach(() => {
    if ((globalThis as GlobalWithProcess).process?.env) {
      (globalThis as GlobalWithProcess).process!.env!.ASYLIA_HW_DEBUG = originalDebugEnv;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('redacts hardware-wallet secrets while preserving support-safe fields', () => {
    const redacted = redactLogContext({
      policyHmac: TXID,
      psbtBase64: PSBT,
      txid: TXID,
      destinationAddress: ADDRESS,
      masterFingerprint: 'deadbeef',
      response: {
        statusCode: 0x6985,
        message: `fingerprint: deadbeef ${XPUB}`,
      },
      phase: 'sign',
      inputCount: 2,
    });

    const rendered = JSON.stringify(redacted);
    expect(rendered).not.toContain(XPUB);
    expect(rendered).not.toContain(PSBT);
    expect(rendered).not.toContain(TXID);
    expect(rendered).not.toContain(ADDRESS);
    expect(rendered).not.toContain('deadbeef');
    expect(redacted).toMatchObject({
      phase: 'sign',
      inputCount: 2,
      response: { redacted: true, statusCode: 0x6985 },
    });
  });

  it('suppresses routine info by default and redacts error context', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    log.info('request', { xpub: XPUB });
    log.error('failure', { response: { statusCode: 0x6985, message: XPUB } });

    expect(consoleInfo).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain(XPUB);
  });

  it('redacts descriptor-shaped free text before individual key material can leak', () => {
    const descriptor = `wsh(sortedmulti(2,[deadbeef/48h/0h/0h/2h]${XPUB}/0/*,[f00dbabe/48h/0h/0h/2h]${XPUB}/0/*))`;

    expect(redactLogContext({ detail: `policy=${descriptor}` })).toEqual({
      detail: '[redacted:descriptor]',
    });
  });

  it('redacts deeply nested and circular SDK payloads', () => {
    const circular: Record<string, unknown> = { phase: 'sign' };
    circular.self = circular;

    const redacted = redactLogContext({
      circular,
      deep: { a: { b: { c: { d: { e: { f: 'safe' } } } } } },
    });

    expect(redacted.circular).toMatchObject({
      phase: 'sign',
      self: '[redacted:circular]',
    });
    expect(redacted.deep).toMatchObject({
      a: { b: { c: { d: '[redacted:depth]' } } },
    });
  });

  it('redacts Error instances and strips raw nested payloads from sensitive summaries', () => {
    const cause = new Error(`transport rejected ${XPUB} for ${ADDRESS}`);
    cause.name = 'TransportStatusError';

    const redacted = redactLogContext({
      cause,
      payload: {
        error: 'denied_by_user',
        message: `txid=${TXID}`,
        statusCode: 0x6985,
        raw: { xpub: XPUB, psbt: PSBT },
      },
    });

    expect(redacted.cause).toEqual({ redacted: true });
    expect(redacted.payload).toEqual({
      redacted: true,
      statusCode: 0x6985,
    });
    expect(JSON.stringify(redacted)).not.toContain(XPUB);
    expect(JSON.stringify(redacted)).not.toContain(PSBT);
  });

  it('keeps stable codes but strips plain vendor messages from console context', () => {
    const redacted = redactLogContext({
      error: new Error('Ledger vendor transport detail'),
      response: {
        statusCode: 0x6985,
        message: 'Ledger vendor transport detail',
      },
      note: 'Ledger vendor transport detail',
    });

    const rendered = JSON.stringify(redacted);
    expect(redacted.response).toEqual({
      redacted: true,
      statusCode: 0x6985,
    });
    expect(rendered).not.toContain('Ledger vendor transport detail');
  });

  it.each(['1', 'true'])('enables routine info logs when ASYLIA_HW_DEBUG=%s', (value) => {
    if ((globalThis as GlobalWithProcess).process?.env) {
      (globalThis as GlobalWithProcess).process!.env!.ASYLIA_HW_DEBUG = value;
    }
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    expect(isHardwareDebugLoggingEnabled()).toBe(true);
    log.info('request', { xpub: XPUB });

    expect(consoleInfo).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleInfo.mock.calls[0])).not.toContain(XPUB);
  });

  it('supports localStorage debug opt-in and ignores storage access failures', () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => '1'),
    });
    expect(isHardwareDebugLoggingEnabled()).toBe(true);

    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => {
        throw new Error('storage denied');
      }),
    });
    expect(isHardwareDebugLoggingEnabled()).toBe(false);
  });

  it('always emits warning logs with redacted context', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    log.warn('warning', { policy: `ledger ${XPUB}` });

    expect(consoleWarn).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleWarn.mock.calls[0])).not.toContain(XPUB);
    expect(consoleWarn.mock.calls[0]?.[1]).toMatchObject({
      policy: 'ledger [redacted:xpub]',
    });
  });
});
