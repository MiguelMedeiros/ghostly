import type { DeviceKind } from "@ghostly/core";
import { DB_VERSION } from "../shared/idb";
import type { HandoffSelf, HandoffSource, HandoffStagingHost } from "./handoff";

/*
 * What the handoff needs of the app around the engine (WISP 06 § The handoff): where a profile's storage is and how to
 * point the profile at another namespace. Those are the app's (its registry of profiles and their local keys, its
 * backup format), so the app registers them here before the engine starts, and the engine and device-link-only mode
 * both find them here. Without them a device can neither give nor take a profile: a handoff is refused.
 */

export interface HandoffProfileHost {
  /** The app's version, as `handoff-hello` says it. */
  readonly app: string;
  readonly kind: DeviceKind;
  /** A profile's files and the rest of it, read without writing: its peer database is opened without a version. */
  source(database: string): HandoffSource;
  /** The staging namespaces a pull writes into, and the registry pointer. */
  readonly staging: HandoffStagingHost;
  /** The version a database is stored at, read without changing it; null when there is none. */
  storedVersion(database: string): Promise<number | null>;
}

let host: HandoffProfileHost | null = null;

/** Before the engine starts. The CLI registers none: its profiles are never on several devices. */
export function setHandoffProfileHost(next: HandoffProfileHost | null): void {
  host = next;
}

export function handoffProfileHost(): HandoffProfileHost | null {
  return host;
}

/**
 * The wallet SDK each wallet type runs on, pinned (WISP 06 § Versions): a wallet whose pin differs between two devices
 * does not move. These are the versions `packages/browser/package.json` pins; a test checks the two agree.
 */
export const WALLET_SDK_PINS: Readonly<Record<string, string>> = {
  ark: "0.4.76",
  bark: "0.25.0",
  breez: "0.26.0",
  fedimint: "eea6a3c98909",
};

/** Whether this connection costs by the byte, where the browser says (`navigator.connection`); false where it does not. */
export function meteredConnection(): boolean {
  const connection = (typeof navigator === "undefined" ? undefined : (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection);
  return connection?.saveData === true || connection?.type === "cellular";
}

/** Bytes this origin may still store, or -1 where the browser does not say. */
async function room(): Promise<number> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota === undefined) return -1;
    return Math.max(0, Math.floor(estimate.quota - (estimate.usage ?? 0)));
  } catch { return -1; }
}

/** What this device says about itself in `handoff-hello`. */
export async function handoffSelf(profileHost: Pick<HandoffProfileHost, "app" | "kind">): Promise<HandoffSelf> {
  return { app: profileHost.app.replace(/[^0-9A-Za-z.+_-]/g, "").slice(0, 40) || "0", db: DB_VERSION, pins: { ...WALLET_SDK_PINS }, kind: profileHost.kind, room: await room(), metered: meteredConnection() };
}
