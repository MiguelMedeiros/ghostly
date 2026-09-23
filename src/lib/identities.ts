import { useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { identityProvider, identityProviders } from "@ghostly/browser/proofs/registry";
import { availableSigners } from "@ghostly/browser/proofs/verify";
import type { IdentityPlatform, IdentityProofProvider } from "@ghostly/browser/proofs/contract";
import type { IdentityStatus, SharedIdentity } from "@ghostly/core";
import type { ReceivedIdentityView } from "@ghostly/browser/shared/types";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
/** The engine's state, re-rendered on every change. */
export const useEngineState = () => useSyncExternalStore(subscribe, snapshot);

/** Where this page runs, for signers that only work on some platforms (a NIP-07 extension is in web pages). */
export function identityPlatform(): IdentityPlatform {
  if (typeof location !== "undefined" && /-extension:$/.test(location.protocol)) return "extension";
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return "desktop";
  return "web";
}

/** Providers that can be added here: on this platform, with at least one signer available now. */
export function addableProviders(): IdentityProofProvider[] {
  const platform = identityPlatform();
  return identityProviders().filter(p => p.platforms.includes(platform) && availableSigners(p, platform).length > 0);
}

export const providerOf = (id: string) => identityProvider(id);
export const providerLabel = (id: string) => identityProvider(id)?.label ?? id;
export const shortSubject = (provider: string, subject: string) => {
  const p = identityProvider(provider);
  try { return p?.subject.short?.(subject) ?? subject; } catch { return subject; }
};
export const categoryLabel = (id: string, attester?: string) =>
  identityProvider(id)?.category === "provider-attested" ? `Attested by ${attester ?? "the provider"}` : "Their own key";

export const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
export const dateTime = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export const RECEIVED_STATUS: Record<IdentityStatus, string> = {
  verified: "Verified",
  expired: "Expired",
  withdrawn: "No longer shared",
  unconfirmed: "Could not be confirmed",
  "previous-key": "From a previous key",
};
export const SHARED_STATUS: Record<SharedIdentity["status"], string> = {
  queued: "Shared when you next connect",
  pending: "Waiting for your contact",
  accepted: "Shared · verified by your contact",
  rejected: "Not verified by your contact",
  "withdrawal-pending": "Stopping…",
  withdrawn: "Not shared",
};

/** The engine's status, with expiry applied at render time: an expired proof is never shown as verified. */
export const currentStatus = (r: ReceivedIdentityView, now = Date.now() / 1000): IdentityStatus =>
  r.status === "verified" || r.status === "unconfirmed" ? (r.expiresAt <= now ? "expired" : r.status) : r.status;
