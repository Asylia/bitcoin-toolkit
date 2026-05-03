/**
 * Minimal ambient Web Bluetooth types.
 *
 * TypeScript's DOM lib does not expose every Web Bluetooth shape this
 * package touches in a stable way. Keep the local declaration narrow so
 * the public wallet app never has to import browser-experimental types.
 */

interface BluetoothAvailabilityChangedEvent extends Event {
  readonly value: boolean;
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
}

interface BluetoothDevice extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
  addEventListener(
    type: 'gattserverdisconnected',
    listener: (event: Event) => void,
  ): void;
  removeEventListener(
    type: 'gattserverdisconnected',
    listener: (event: Event) => void,
  ): void;
}

interface Bluetooth {
  getAvailability?(): Promise<boolean>;
  getDevices?(): Promise<BluetoothDevice[]>;
  requestDevice(options?: unknown): Promise<BluetoothDevice>;
  addEventListener(
    type: 'availabilitychanged',
    listener: (event: BluetoothAvailabilityChangedEvent) => void,
  ): void;
  removeEventListener(
    type: 'availabilitychanged',
    listener: (event: BluetoothAvailabilityChangedEvent) => void,
  ): void;
}

interface Navigator {
  readonly bluetooth?: Bluetooth;
}
