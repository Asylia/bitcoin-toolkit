/**
 * Pre-flight environment detection.
 *
 * The Trezor browser story has three different transport realities the
 * user can land in, and they translate into wildly different UI moments:
 *
 *   1. **Trezor Suite Desktop is running.** Suite ships / hosts the
 *      local Trezor service, so the transport probe can succeed even
 *      when no standalone Bridge install exists. Trezor Connect still
 *      owns the official popup prompts and the final export approval
 *      stays on the physical device; Suite may simply be the process
 *      providing transport, or it may be the app currently occupying
 *      the device.
 *   2. **Trezor Bridge is installed (Suite not running).** SDK uses a
 *      persistent iframe + Bridge transport; PIN entry happens in
 *      Trezor's popup (`connect.trezor.io/.../popup.html`) but the
 *      device session is sticky so device events stream back into the
 *      SPA. The wallet should tell the user "a small Trezor popup will
 *      open, complete the prompts there."
 *   3. **Neither is present.** SDK falls back to popup mode using
 *      WebUSB inside the popup. Works in Chromium-based browsers only;
 *      Safari and Firefox without Bridge cannot talk to the device at
 *      all. The wallet should tell the user "a popup at
 *      connect.trezor.io will open" or, in unsupported browsers,
 *      surface a precise install prompt up-front instead of letting
 *      the popup attempt fail mysteriously.
 *
 * This module exposes `detectTrezorEnvironment()` — a single async
 * call that probes all three signals in parallel with a short
 * wall-clock cap so the UI never blocks while a hopeful localhost
 * fetch waits for a connection that is never coming. Pure detection,
 * no SDK init, no side effects.
 */

import { log } from './log';

/**
 * Default Bridge port. Trezor Bridge and the bridge embedded in
 * Trezor Suite Desktop both listen here on every supported OS. The
 * server replies with a small JSON document on `GET /` that includes
 * the version string, plus permissive CORS headers so a third-party
 * page can probe it.
 *
 * https://docs.trezor.io/trezor-suite/packages/bridge.html
 */
const BRIDGE_DEFAULT_PORT = 21325;

/**
 * Wall-clock cap on the localhost probe. Bridge replies in single-
 * digit milliseconds when present; if it does not answer within this
 * window the user almost certainly does not have it installed and we
 * should not keep them waiting on a wizard mount.
 */
const PROBE_TIMEOUT_MS = 800;

/**
 * Browser engine family the SDK transport story branches on. Anything
 * not in this set is reported as `'other'`; the UI treats `'other'`
 * the same as `'firefox'` for guidance purposes (no WebUSB).
 */
export type TrezorBrowserFamily =
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
export type TrezorEnvironment = {
  /**
   * `true` when the Bridge HTTP probe answered within
   * {@link PROBE_TIMEOUT_MS}. The same probe is positive when Trezor
   * Suite Desktop is running because Suite hosts the Bridge process
   * internally (no separate install needed) — see {@link suiteLikely}.
   *
   * `false` is a hard "we tried and got no answer" signal, NOT
   * "definitely missing". A user-installed firewall or a corporate
   * proxy can swallow the request; the wizard should treat `false`
   * as guidance, not a blocker.
   */
  bridgePresent: boolean;
  /** Bridge build number reported by `GET /`, when readable. */
  bridgeVersion: string | null;
  /**
   * `true` when the Bridge probe response carries the embedded-Suite
   * marker. Useful so the wizard can render "the local Trezor service
   * is already running" without pretending that Suite owns the popup
   * or on-device prompts.
   *
   * `null` when we have no signal either way (probe failed, or older
   * Bridge build with no marker).
   */
  suiteLikely: boolean | null;
  /** WebUSB API surface available to this page. */
  webUsbAvailable: boolean;
  /** Browser engine family parsed from `navigator.userAgent`. */
  browserFamily: TrezorBrowserFamily;
  /**
   * `true` when the page can reach a working Trezor transport without
   * any further user action. Mirrors the SDK's own auto-resolution:
   * Bridge present → iframe transport works; otherwise WebUSB needed.
   */
  canReachDevice: boolean;
  /**
   * Single-line, user-facing summary of how the connect step will
   * behave. Pre-computed so the wizard does not have to map the
   * raw signals itself.
   */
  recommendation: TrezorRecommendation;
};

/**
 * Pre-rendered guidance derived from the raw signals. The wizard
 * reads `mode` for branching logic and `headline` / `body` /
 * `actionHint` for the inline copy.
 */
export type TrezorRecommendation = {
  /**
   * - `suite` — the local Trezor service was detected and appears to
   *   be hosted by Trezor Suite. Connect / device prompts still happen
   *   through the official Trezor Connect flow.
   * - `bridge_popup` — Trezor's small popup will open, talking to
   *   the device through the installed Bridge.
   * - `webusb_popup` — Trezor's popup will open and use WebUSB
   *   inside the popup. Browser must support WebUSB.
   * - `blocked_install_required` — neither path is reachable from
   *   this browser without installing Bridge or switching browser.
   */
  mode:
    | 'suite'
    | 'bridge_popup'
    | 'webusb_popup'
    | 'blocked_install_required';
  /** Short, non-technical title for the inline coach card. */
  headline: string;
  /** One-sentence explanation of what will happen on Connect. */
  body: string;
  /** Optional one-line nudge ("Allow popups", "Open Trezor Suite", …). */
  actionHint: string | null;
};

/** Internal probe result kept private to the module. */
type BridgeProbe = {
  reachable: boolean;
  version: string | null;
  suiteLikely: boolean | null;
};

/**
 * Run every detection probe in parallel and return a single normalised
 * snapshot. The wizard can call this on mount and re-call it when the
 * user clicks Retry to pick up freshly-installed Bridge / freshly-
 * launched Suite without a page reload.
 */
export async function detectTrezorEnvironment(): Promise<TrezorEnvironment> {
  log.info('environment detection start');

  const [bridge] = await Promise.all([probeBridge()]);
  const webUsbAvailable = detectWebUsb();
  const browserFamily = detectBrowserFamily();

  // SDK's own auto resolution is "iframe if Bridge, popup otherwise".
  // The popup itself uses WebUSB (Chromium-only). So the page can
  // always reach the device when Bridge is up; without Bridge it
  // needs WebUSB.
  const canReachDevice = bridge.reachable || webUsbAvailable;

  const recommendation = buildRecommendation({
    bridge,
    webUsbAvailable,
    browserFamily,
  });

  const env: TrezorEnvironment = {
    bridgePresent: bridge.reachable,
    bridgeVersion: bridge.version,
    suiteLikely: bridge.suiteLikely,
    webUsbAvailable,
    browserFamily,
    canReachDevice,
    recommendation,
  };
  log.info('environment detection done', { env });
  return env;
}

/**
 * Probe the Bridge HTTP endpoint. The response shape we care about:
 *
 *   { version: "2.0.32", configured: true, ... }
 *
 * Recent builds embedded inside Trezor Suite Desktop add a
 * `runningInSuite` (or similar) marker. We read it best-effort and
 * report `suiteLikely` as `null` when the marker is missing instead
 * of guessing (so the wizard can pick between "definitely Suite",
 * "Bridge but maybe Suite", and "Bridge alone" wording).
 */
async function probeBridge(): Promise<BridgeProbe> {
  if (typeof fetch !== 'function') {
    log.info('bridge probe skipped (no fetch)');
    return { reachable: false, version: null, suiteLikely: null };
  }
  if (typeof AbortController !== 'function') {
    log.info('bridge probe skipped (no AbortController)');
    return { reachable: false, version: null, suiteLikely: null };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    PROBE_TIMEOUT_MS,
  );
  const url = `http://127.0.0.1:${BRIDGE_DEFAULT_PORT}/`;
  log.info('bridge probe request', { url, timeoutMs: PROBE_TIMEOUT_MS });
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      // Bridge sets `Access-Control-Allow-Origin: *` so a default
      // CORS request from a third-party origin succeeds. Default
      // mode is enough; explicit `cors` is set for clarity.
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) {
      log.warn('bridge probe non-ok status', { status: response.status });
      return { reachable: false, version: null, suiteLikely: null };
    }
    const text = await response.text();
    const parsed = safeParseJson(text);
    const version = readVersion(parsed);
    const suiteLikely = readSuiteMarker(parsed);
    log.info('bridge probe success', { version, suiteLikely });
    return { reachable: true, version, suiteLikely };
  } catch (cause) {
    log.info('bridge probe failed', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return { reachable: false, version: null, suiteLikely: null };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readVersion(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const value = (parsed as Record<string, unknown>).version;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Best-effort detection of the embedded-Suite Bridge build. The exact
 * marker varies by Bridge version; covering the few we know about
 * keeps the wizard honest without false positives. Returns `null` when
 * we have no usable signal so the UI can fall back to the generic
 * "Bridge" wording.
 */
function readSuiteMarker(parsed: unknown): boolean | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  // Known markers across Bridge / Suite-Bridge builds.
  if (record.runningInSuite === true) return true;
  if (record.suite === true) return true;
  if (typeof record.id === 'string' && record.id.toLowerCase().includes('suite'))
    return true;
  return null;
}

function detectWebUsb(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Reading `'usb' in navigator` is enough — even when the API is
  // permission-gated (corporate policies, insecure context) the
  // property exists. The SDK itself does the actual permission
  // request later, on the user gesture that opens the popup.
  // The DOM lib types `Navigator` as a sealed interface; cast through
  // `unknown` so the `in` check compiles in strict mode without
  // dragging an experimental WebUSB type definition into this package.
  return 'usb' in (navigator as unknown as Record<string, unknown>);
}

function detectBrowserFamily(): TrezorBrowserFamily {
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
  bridge: BridgeProbe;
  webUsbAvailable: boolean;
  browserFamily: TrezorBrowserFamily;
}): TrezorRecommendation {
  const { bridge, webUsbAvailable, browserFamily } = input;

  // Suite Desktop's bundled local service is reachable. Do not tell the
  // user that prompts happen "inside Suite" — the confirmation still
  // appears on the physical device and Connect may still open its popup.
  if (bridge.reachable && bridge.suiteLikely === true) {
    return {
      mode: 'suite',
      headline: 'Trezor transport is already available',
      body: 'We detected the local Trezor service, likely from Trezor Suite. Clicking Connect may open the official Trezor Connect popup for browser-side input; the export approval happens on the Trezor screen.',
      actionHint:
        'Keep the device unlocked. If Suite says the device is busy, finish or close that flow before retrying.',
    };
  }

  // Bridge is up, Suite is not running (or we cannot prove it). The
  // SDK will use its persistent iframe + a small popup window for
  // the prompts that need user input.
  if (bridge.reachable) {
    return {
      mode: 'bridge_popup',
      headline: 'A small Trezor popup will open',
      body: 'Trezor Bridge is installed, so the transport is ready. The official popup at connect.trezor.io handles browser-side permission, PIN, or passphrase prompts; final export approval appears on the Trezor screen.',
      actionHint: 'Allow popups from this page and keep the device screen visible.',
    };
  }

  // No Bridge but the browser can do WebUSB — the popup will hold
  // the WebUSB session itself.
  if (webUsbAvailable) {
    return {
      mode: 'webusb_popup',
      headline: 'A Trezor popup will pair the device',
      body: 'Without Trezor Bridge, an official popup at connect.trezor.io will open and use WebUSB to talk to your device directly. Browser permissions happen in the popup; export approval happens on the Trezor screen.',
      actionHint: 'Allow popups, approve the WebUSB permission, and watch the device.',
    };
  }

  // No Bridge and no WebUSB — Safari / Firefox without Bridge.
  if (browserFamily === 'safari') {
    return {
      mode: 'blocked_install_required',
      headline: 'Safari cannot talk to Trezor directly',
      body: 'Safari does not support WebUSB. Install Trezor Suite (which ships the bridge service) and run it once, then come back and try again — or open this page in a Chromium-based browser.',
      actionHint: 'Install Trezor Suite or switch to Chrome / Brave / Edge.',
    };
  }
  if (browserFamily === 'firefox') {
    return {
      mode: 'blocked_install_required',
      headline: 'Firefox needs Trezor Bridge',
      body: 'Firefox does not expose WebUSB to web pages. Install Trezor Suite (which ships the bridge service) and run it once, then come back and try again — or open this page in a Chromium-based browser.',
      actionHint: 'Install Trezor Suite or switch to Chrome / Brave / Edge.',
    };
  }
  return {
    mode: 'blocked_install_required',
    headline: 'No way to reach a Trezor from this browser',
    body: 'We could not find Trezor Bridge or a WebUSB API. Install Trezor Suite (which ships the bridge service) and run it once, then come back and try again.',
    actionHint: 'Install Trezor Suite, then click Retry.',
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
    TrezorEnvironment,
    'bridgePresent' | 'suiteLikely' | 'webUsbAvailable' | 'browserFamily' | 'bridgeVersion'
  >,
): TrezorRecommendation {
  return buildRecommendation({
    bridge: {
      reachable: env.bridgePresent,
      version: env.bridgeVersion,
      suiteLikely: env.suiteLikely,
    },
    webUsbAvailable: env.webUsbAvailable,
    browserFamily: env.browserFamily,
  });
}
