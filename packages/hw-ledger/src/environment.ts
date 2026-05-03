/// <reference path="./webbluetooth-types.d.ts" />
/**
 * Pre-flight environment detection.
 *
 * Ledger's browser story is narrower than Trezor's — there is no
 * "Bridge" to probe and no desktop companion to forward prompts
 * through. Asylia supports the two browser-native Ledger channels:
 * WebHID over USB and Web Bluetooth over BLE. The environment detector
 * therefore focuses on four signals:
 *
 *   1. Is WebHID available at all? (navigator.hid)
 *   2. Is Web Bluetooth available at all? (navigator.bluetooth)
 *   3. Which browser engine are we in? (Chromium / Firefox / Safari)
 *   4. Has the user already authorised a Ledger on this origin?
 *
 * From those three we pre-compute the recommendation the wizard
 * renders verbatim, so the visual surface only has one place to read
 * the story from. Shape is kept parallel to
 * `@asylia/hw-trezor`'s `TrezorEnvironment` so the wallet wizard can
 * treat both families through symmetric props.
 */

import { log } from './log';
import {
  findAuthorisedLedgerBluetoothDevice,
  findAuthorisedLedgerDevice,
} from './transport';
import type { LedgerTransportChannel } from './types';

/**
 * Browser engine family the SDK transport story branches on. Anything
 * not in this set is reported as `'other'`; the UI treats `'other'`
 * the same as `'firefox'` for guidance purposes (no WebHID).
 */
export type LedgerBrowserFamily =
  | 'chromium'
  | 'firefox'
  | 'safari'
  | 'other'
  | 'unknown';

/**
 * Snapshot of every signal the wizard needs to pick the right copy
 * for the connect step. All fields are best-effort: when a probe is
 * inconclusive we report `null` rather than guessing, so the UI can
 * choose between "we know" and "we cannot tell" wording.
 */
export type LedgerEnvironment = {
  /** WebHID API surface available to this page. */
  webHidAvailable: boolean;
  /** Web Bluetooth API surface available to this page. */
  webBluetoothAvailable: boolean;
  /** Browser transports that can be used from a click handler. */
  availableTransports: readonly LedgerTransportChannel[];
  /** Transport the adapter will use if the user clicks Connect now. */
  recommendedTransport: LedgerTransportChannel | null;
  /** Browser engine family parsed from `navigator.userAgent`. */
  browserFamily: LedgerBrowserFamily;
  /**
   * `true` when either WebHID or Web Bluetooth returns a Ledger device
   * the user has previously authorised on this origin. Lets the wizard
   * skip the picker and go straight to "we know your device" copy.
   */
  previouslyAuthorised: boolean;
  /** The already-authorised transport, when one was found. */
  previouslyAuthorisedTransport: LedgerTransportChannel | null;
  /**
   * `true` when the page can reach a working Ledger transport without
   * further user action (supported browser transport + at least an
   * authorised device; we do NOT assume a picker click on first visit).
   *
   * The wizard still shows a "Connect device" CTA regardless — the
   * WebHID picker must be fired from a user gesture — but this flag
   * lets the wizard render a quieter coach card when the machine is
   * already set up.
   */
  canReachDevice: boolean;
  /**
   * Single-line, user-facing summary of how the connect step will
   * behave. Pre-computed so the wizard does not have to map the raw
   * signals itself.
   */
  recommendation: LedgerRecommendation;
};

/**
 * Pre-rendered guidance derived from the raw signals. The wizard reads
 * `mode` for branching logic and `headline` / `body` / `actionHint`
 * for the inline copy.
 */
export type LedgerRecommendation = {
  /**
   * - `ready_authorised` — WebHID is up and a Ledger is already paired
   *   to this origin. No picker on Connect.
   * - `ready_picker` — WebHID is up but no device is paired yet.
   *   The browser picker will open on Connect.
   * - `blocked_install_required` — the browser cannot talk to a Ledger
   *   at all (Safari / Firefox / non-HTTPS).
   */
  mode: 'ready_authorised' | 'ready_picker' | 'blocked_install_required';
  /** Transport this recommendation describes, or null when blocked. */
  transport: LedgerTransportChannel | null;
  /** Short, non-technical title for the inline coach card. */
  headline: string;
  /** One-sentence explanation of what will happen on Connect. */
  body: string;
  /** Optional one-line nudge ("Open Bitcoin app", "Use Chrome", …). */
  actionHint: string | null;
};

/**
 * Run every detection probe and return a single normalised snapshot.
 * Safe to call on mount and to re-call when the user clicks Retry —
 * the probes are all synchronous or near-synchronous, and none of
 * them trigger a permission prompt.
 */
export async function detectLedgerEnvironment(): Promise<LedgerEnvironment> {
  log.info('environment detection start');

  const webHidAvailable = detectWebHid();
  const webBluetoothAvailable = await detectWebBluetooth();
  const availableTransports = [
    ...(webHidAvailable ? (['webhid'] as const) : []),
    ...(webBluetoothAvailable ? (['webble'] as const) : []),
  ];
  const browserFamily = detectBrowserFamily();
  const authorisedHid = webHidAvailable
    ? (await findAuthorisedLedgerDevice()) !== null
    : false;
  const authorisedBle = webBluetoothAvailable
    ? (await findAuthorisedLedgerBluetoothDevice()) !== null
    : false;
  const previouslyAuthorised = authorisedHid || authorisedBle;
  const previouslyAuthorisedTransport: LedgerTransportChannel | null =
    authorisedHid ? 'webhid' : authorisedBle ? 'webble' : null;
  const recommendedTransport =
    previouslyAuthorisedTransport ?? availableTransports[0] ?? null;

  const canReachDevice = previouslyAuthorised && recommendedTransport !== null;

  const recommendation = buildRecommendation({
    webHidAvailable,
    webBluetoothAvailable,
    availableTransports,
    recommendedTransport,
    browserFamily,
    previouslyAuthorised,
    previouslyAuthorisedTransport,
  });

  const env: LedgerEnvironment = {
    webHidAvailable,
    webBluetoothAvailable,
    availableTransports,
    recommendedTransport,
    browserFamily,
    previouslyAuthorised,
    previouslyAuthorisedTransport,
    canReachDevice,
    recommendation,
  };
  log.info('environment detection done', { env });
  return env;
}

function detectWebHid(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return false;
  }
  if (detectPermissionsPolicyFeature('hid') === false) {
    log.warn('webhid unavailable — Permissions-Policy blocks hid');
    return false;
  }
  // Reading `'hid' in navigator` is enough — even when the API is
  // permission-gated (corporate policies) the property exists. The
  // SDK itself does the actual permission request later.
  return 'hid' in (navigator as unknown as Record<string, unknown>);
}

async function detectWebBluetooth(): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return false;
  }
  if (detectPermissionsPolicyFeature('bluetooth') === false) {
    log.warn('web bluetooth unavailable — Permissions-Policy blocks bluetooth');
    return false;
  }
  const bluetooth = (navigator as unknown as { bluetooth?: Bluetooth }).bluetooth;
  if (!bluetooth) return false;
  if (typeof bluetooth.getAvailability !== 'function') return true;
  try {
    return await bluetooth.getAvailability();
  } catch (cause) {
    log.warn('web bluetooth availability probe failed', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return true;
  }
}

type BrowserPermissionsPolicy = {
  allowsFeature?: (feature: string) => boolean;
};

type BrowserDocumentWithPermissionsPolicy = {
  permissionsPolicy?: BrowserPermissionsPolicy;
  featurePolicy?: BrowserPermissionsPolicy;
};

function detectPermissionsPolicyFeature(feature: 'hid' | 'bluetooth'): boolean | null {
  if (typeof document === 'undefined') return null;
  const browserDocument = document as unknown as BrowserDocumentWithPermissionsPolicy;
  const policy = browserDocument.permissionsPolicy ?? browserDocument.featurePolicy;
  if (typeof policy?.allowsFeature !== 'function') return null;
  try {
    return policy.allowsFeature(feature);
  } catch (cause) {
    log.warn('permissions policy probe failed', {
      feature,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return null;
  }
}

function detectBrowserFamily(): LedgerBrowserFamily {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent || '';
  // Order matters: Chrome / Edge / Brave all carry "Safari" too, so
  // Safari has to be the *last* check after we exclude Chromium.
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\/|EdgA\//.test(ua)) return 'chromium';
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return 'chromium';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari';
  return 'other';
}

/**
 * Map raw probe signals into the user-facing copy the wizard renders
 * verbatim. Centralised so the visual surface only has one place to
 * read the recommendation from.
 */
function buildRecommendation(input: {
  webHidAvailable: boolean;
  webBluetoothAvailable: boolean;
  availableTransports: readonly LedgerTransportChannel[];
  recommendedTransport: LedgerTransportChannel | null;
  browserFamily: LedgerBrowserFamily;
  previouslyAuthorised: boolean;
  previouslyAuthorisedTransport: LedgerTransportChannel | null;
}): LedgerRecommendation {
  const {
    webHidAvailable,
    webBluetoothAvailable,
    availableTransports,
    recommendedTransport,
    browserFamily,
    previouslyAuthorised,
    previouslyAuthorisedTransport,
  } = input;

  if (recommendedTransport && previouslyAuthorised) {
    const label = transportLabel(previouslyAuthorisedTransport ?? recommendedTransport);
    return {
      mode: 'ready_authorised',
      transport: recommendedTransport,
      headline: 'Ledger is ready to pair',
      body: `A Ledger is already paired with this browser over ${label}. When you click Connect, Asylia will talk to it directly — no picker and no extra prompts. Open the Bitcoin app on the device first.`,
      actionHint: 'Unlock the device and open the Bitcoin app.',
    };
  }

  if (recommendedTransport) {
    const hasBoth = availableTransports.length > 1;
    const label = transportLabel(recommendedTransport);
    return {
      mode: 'ready_picker',
      transport: recommendedTransport,
      headline: hasBoth
        ? 'Choose USB or Bluetooth, then connect'
        : 'A Ledger picker will open',
      body: hasBoth
        ? 'This browser can reach a Ledger over USB or Bluetooth. Choose the connection method below, unlock the device, open the Bitcoin app, then click Connect.'
        : `Unlock the device and open the Bitcoin app. Clicking Connect opens the browser-native ${label} picker — pick the Ledger and grant access.`,
      actionHint:
        'Have the Bitcoin app open on the device before you click Connect.',
    };
  }

  if (browserFamily === 'safari') {
    return {
      mode: 'blocked_install_required',
      transport: null,
      headline: 'Safari cannot talk to a Ledger',
      body: 'Safari does not implement the WebHID or Web Bluetooth paths Asylia uses to reach the device. Switch to Chrome, Brave, Edge, or another Chromium-based browser and try again.',
      actionHint: 'Open this page in Chrome / Brave / Edge.',
    };
  }

  if (browserFamily === 'firefox') {
    return {
      mode: 'blocked_install_required',
      transport: null,
      headline: 'Firefox does not support WebHID',
      body: 'Firefox does not expose the WebHID or Web Bluetooth APIs needed to reach a Ledger. Open this page in a Chromium-based browser (Chrome, Brave, Edge) and try again.',
      actionHint: 'Open this page in Chrome / Brave / Edge.',
    };
  }

  return {
    mode: 'blocked_install_required',
    transport: null,
    headline: 'No way to reach a Ledger from this browser',
    body: webHidAvailable || webBluetoothAvailable
      ? 'A Ledger transport was detected, but it is blocked by the current browser policy. Make sure the page is served over HTTPS and device APIs are allowed.'
      : 'WebHID and Web Bluetooth are not available. Make sure the page is served over HTTPS and you are using a recent Chromium-based browser — Chrome, Brave, or Edge.',
    actionHint: 'Use a Chromium-based browser over HTTPS, then click Retry.',
  };
}

function transportLabel(transport: LedgerTransportChannel): string {
  return transport === 'webble' ? 'Bluetooth' : 'USB';
}

/**
 * Visible for tests and for surfaces that want to render the same
 * recommendation text from a synthetic environment (design-system
 * stories, Storybook fixtures, error-recovery flows that inject a
 * specific failure to preview).
 */
export function recommendationFromEnvironment(
  env: Pick<
    LedgerEnvironment,
    | 'webHidAvailable'
    | 'webBluetoothAvailable'
    | 'availableTransports'
    | 'recommendedTransport'
    | 'browserFamily'
    | 'previouslyAuthorised'
    | 'previouslyAuthorisedTransport'
  >,
): LedgerRecommendation {
  return buildRecommendation({
    webHidAvailable: env.webHidAvailable,
    webBluetoothAvailable: env.webBluetoothAvailable,
    availableTransports: env.availableTransports,
    recommendedTransport: env.recommendedTransport,
    browserFamily: env.browserFamily,
    previouslyAuthorised: env.previouslyAuthorised,
    previouslyAuthorisedTransport: env.previouslyAuthorisedTransport,
  });
}
