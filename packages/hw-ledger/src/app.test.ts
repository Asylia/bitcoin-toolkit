import type { AppClient } from '@ledgerhq/ledger-bitcoin';
import { describe, expect, it, vi } from 'vitest';

import { buildDeviceInfo, readAppMetadata, readFingerprint } from './app';

describe('Ledger app helpers', () => {
  it('accepts supported Bitcoin app metadata', async () => {
    const client = appClient({
      getAppAndVersion: vi.fn(async () => ({
        name: 'Bitcoin Test',
        version: '2.1.0',
        flags: {},
      })),
    });

    await expect(readAppMetadata(client)).resolves.toEqual({
      ok: true,
      data: { appName: 'Bitcoin Test', appVersion: '2.1.0' },
    });
  });

  it('maps dashboard, wrong app, and outdated app metadata to adapter errors', async () => {
    await expect(
      readAppMetadata(appClient({
        getAppAndVersion: vi.fn(async () => ({
          name: 'BOLOS',
          version: '2.2.0',
          flags: {},
        })),
      })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'app_not_open', cause: 'app name: BOLOS' },
    });

    await expect(
      readAppMetadata(appClient({
        getAppAndVersion: vi.fn(async () => ({
          name: 'Ethereum',
          version: '2.2.0',
          flags: {},
        })),
      })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'wrong_app', cause: 'app name: Ethereum' },
    });

    await expect(
      readAppMetadata(appClient({
        getAppAndVersion: vi.fn(async () => ({
          name: 'Bitcoin',
          version: '2.0.9',
          flags: {},
        })),
      })),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'app_outdated',
        cause: 'Bitcoin app 2.0.9 < required 2.1.0',
      },
    });
  });

  it('normalises app metadata exceptions', async () => {
    await expect(
      readAppMetadata(appClient({
        getAppAndVersion: vi.fn(async () => {
          throw Object.assign(new Error('dashboard'), { name: 'DeviceOnDashboardExpected' });
        }),
      })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'wrong_app' },
    });
  });

  it('normalises and validates master fingerprints', async () => {
    await expect(
      readFingerprint(appClient({
        getMasterFingerprint: vi.fn(async () => ' A1B2C3D4 '),
      })),
    ).resolves.toEqual({ ok: true, data: 'a1b2c3d4' });

    await expect(
      readFingerprint(appClient({
        getMasterFingerprint: vi.fn(async () => 'not-hex'),
      })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'descriptor_unavailable' },
    });
  });

  it('normalises fingerprint exceptions and builds device metadata', async () => {
    await expect(
      readFingerprint(appClient({
        getMasterFingerprint: vi.fn(async () => {
          throw Object.assign(new Error('locked'), { name: 'LockedDeviceError' });
        }),
      })),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'device_locked' },
    });

    expect(
      buildDeviceInfo({
        transport: {
          device: {
            productName: 'Ledger Nano S Plus',
            vendorId: 0x2c97,
            productId: 0x5001,
          },
        } as never,
        appName: 'Bitcoin',
        appVersion: '2.2.3',
      }),
    ).toEqual({
      model: 'Ledger Nano S Plus',
      productId: 0x5001,
      appName: 'Bitcoin',
      appVersion: '2.2.3',
    });

    expect(
      buildDeviceInfo({
        transport: {
          deviceModel: { productName: 'Ledger Nano X' },
          device: { name: 'Nano X 1234' },
        } as never,
        appName: 'Bitcoin',
        appVersion: '2.2.3',
      }),
    ).toEqual({
      model: 'Ledger Nano X',
      productId: null,
      appName: 'Bitcoin',
      appVersion: '2.2.3',
    });
  });
});

function appClient(overrides: Partial<AppClient>): AppClient {
  return overrides as AppClient;
}
