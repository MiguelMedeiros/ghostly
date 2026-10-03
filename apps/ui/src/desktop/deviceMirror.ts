import type { DeviceMirror } from "@ghostly/browser/devices/store";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Desktop's second home for a profile's device state (WISP 06 § Durable device state): a file in the app's data
 * folder, written by Rust, which answers only once the bytes are on disk (`fsync`). At start the app takes the
 * stricter of this and the WebView's own database (`readDeviceRecord`).
 */
export function desktopDeviceMirror(invoke: Invoke): DeviceMirror {
  return {
    read: (profile) => invoke<string | null>("device_state_read", { profile }),
    write: (profile, record) => invoke<void>("device_state_write", { profile, record }),
  };
}
