/**
 * Pre-flight environment detection.
 *
 * Ledger's browser story is narrower than Trezor's — the only officially
 * supported path for Asylia is WebHID on a Chromium-based browser over
 * HTTPS. There is no "Bridge" to probe and no desktop companion to
 * forward prompts through. The environment detector therefore focuses
 * on three signals:
 *
 *   1. Is WebHID available at all? (navigator.hid)
 *   2. Which browser engine are we in? (Chromium / Firefox / Safari)
 *   3. Has the user already authorised a Ledger on this origin?
 *
 * From those three we pre-compute the recommendation the wizard
 * renders verbatim, so the visual surface only has one place to read
 * the story from. Shape is kept parallel to
 * `@asylia/hw-trezor`'s `TrezorEnvironment` so the wallet wizard can
 * treat both families through symmetric props.
 */

import { log } from './log';
import { findAuthorisedLedgerDevice } from './transport';

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
  /** Browser engine family parsed from `navigator.userAgent`. */
  browserFamily: LedgerBrowserFamily;
  /**
   * `true` when `navigator.hid.getDevices()` returns a Ledger device
   * the user has previously authorised on this origin. Lets the wizard
   * skip the picker and go straight to "we know your device" copy.
   */
  previouslyAuthorised: boolean;
  /**
   * `true` when the page can reach a working Ledger transport without
   * further user action (WebHID present + at least an authorised
   * device; we do NOT assume a picker click on first visit).
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
  const browserFamily = detectBrowserFamily();
  const previouslyAuthorised = webHidAvailable
    ? (await findAuthorisedLedgerDevice()) !== null
    : false;

  const canReachDevice = webHidAvailable && previouslyAuthorised;

  const recommendation = buildRecommendation({
    webHidAvailable,
    browserFamily,
    previouslyAuthorised,
  });

  const env: LedgerEnvironment = {
    webHidAvailable,
    browserFamily,
    previouslyAuthorised,
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
  // Reading `'hid' in navigator` is enough — even when the API is
  // permission-gated (corporate policies) the property exists. The
  // SDK itself does the actual permission request later.
  return 'hid' in (navigator as unknown as Record<string, unknown>);
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
  browserFamily: LedgerBrowserFamily;
  previouslyAuthorised: boolean;
}): LedgerRecommendation {
  const { webHidAvailable, browserFamily, previouslyAuthorised } = input;

  if (webHidAvailable && previouslyAuthorised) {
    return {
      mode: 'ready_authorised',
      headline: 'Ledger is ready to pair',
      body: 'A Ledger is already paired with this browser. When you click Connect, Asylia will talk to it directly — no picker and no extra prompts. Open the Bitcoin app on the device first.',
      actionHint: 'Unlock the device and open the Bitcoin app.',
    };
  }

  if (webHidAvailable) {
    return {
      mode: 'ready_picker',
      headline: 'A Ledger picker will open',
      body: 'Plug in the device, unlock it, and open the Bitcoin app. Clicking Connect opens the browser-native device picker — pick the Ledger and grant access.',
      actionHint:
        'Have the Bitcoin app open on the device before you click Connect.',
    };
  }

  if (browserFamily === 'safari') {
    return {
      mode: 'blocked_install_required',
      headline: 'Safari cannot talk to a Ledger',
      body: 'Safari does not implement WebHID, which Asylia uses to reach the device. Switch to Chrome, Brave, Edge, or any other Chromium-based browser and try again.',
      actionHint: 'Open this page in Chrome / Brave / Edge.',
    };
  }

  if (browserFamily === 'firefox') {
    return {
      mode: 'blocked_install_required',
      headline: 'Firefox does not support WebHID',
      body: 'Firefox does not expose the WebHID API needed to reach a Ledger. Open this page in a Chromium-based browser (Chrome, Brave, Edge) and try again.',
      actionHint: 'Open this page in Chrome / Brave / Edge.',
    };
  }

  return {
    mode: 'blocked_install_required',
    headline: 'No way to reach a Ledger from this browser',
    body: 'WebHID is not available. Make sure the page is served over HTTPS and you are using a recent Chromium-based browser — Chrome, Brave, or Edge.',
    actionHint: 'Use a Chromium-based browser over HTTPS, then click Retry.',
  };
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
    'webHidAvailable' | 'browserFamily' | 'previouslyAuthorised'
  >,
): LedgerRecommendation {
  return buildRecommendation({
    webHidAvailable: env.webHidAvailable,
    browserFamily: env.browserFamily,
    previouslyAuthorised: env.previouslyAuthorised,
  });
}
