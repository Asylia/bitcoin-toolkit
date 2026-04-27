/**
 * Minimal ambient WebHID types.
 *
 * TypeScript's bundled DOM libs do not include `navigator.hid` yet.
 * `@types/w3c-web-hid` exists but pulling an extra dev dep for the
 * handful of fields this package reads would be wasteful — we only
 * need three types (`HIDDevice`, `HIDConnectionEvent`, and the `hid`
 * property on `Navigator`) and each is small enough to declare here.
 *
 * Scope is kept deliberately narrow:
 *   - Only the fields the adapter reads are declared.
 *   - The types live inside this package so the wallet SPA never has
 *     to import them (it talks to this package through the
 *     `LedgerHidInfo` / `LiveDeviceDescriptor` facades instead).
 *
 * Keep this file in sync with
 * https://webidl.spec.whatwg.org/#idl-index as the WebHID spec
 * stabilises; swap to `@types/w3c-web-hid` the day TS ships HID in
 * the core DOM lib.
 */

interface HIDDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: ReadonlyArray<unknown>;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
}

interface HIDConnectionEvent extends Event {
  readonly device: HIDDevice;
}

interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice;
  readonly reportId: number;
  readonly data: DataView;
}

interface HID extends EventTarget {
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options?: {
    filters?: Array<{ vendorId?: number; productId?: number }>;
    exclusionFilters?: Array<{ vendorId?: number; productId?: number }>;
  }): Promise<HIDDevice[]>;
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: HIDConnectionEvent) => void,
  ): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: HIDConnectionEvent) => void,
  ): void;
}

interface Navigator {
  readonly hid: HID;
}
