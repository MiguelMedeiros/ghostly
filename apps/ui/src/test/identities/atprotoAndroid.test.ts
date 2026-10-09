import { afterEach, describe, expect, it, vi } from "vitest";
import { availableSigners } from "@ghostly/browser/proofs/verify";
import { createAtprotoIdentityProvider } from "@ghostly/browser/proofs/providers/atproto";
import { desktopAtproto, desktopAtprotoHost } from "../../desktop/atproto";

// covers: proofs.atproto

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/*
 * The Android app has no Bluesky sign-in yet: Rust listens on no loopback port there (`oidc_loopback_start` says 0),
 * and the AT Protocol client metadata registers only a loopback redirect for native clients. So the app offers no
 * Bluesky identity there, rather than one that fails before any browser opens. Desktop keeps its loopback sign-in.
 */

const agent = navigator.userAgent;
const setAgent = (value: string) => Object.defineProperty(navigator, "userAgent", { value, configurable: true });

afterEach(() => {
  setAgent(agent);
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("Bluesky in the Android app", () => {
  it("is not offered: no sign-in window, so no signer is available", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    setAgent("Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36");
    expect(desktopAtprotoHost()).toBeUndefined();
    expect(availableSigners(createAtprotoIdentityProvider({ host: desktopAtprotoHost }), "desktop")).toEqual([]);
  });

  it("is offered on Desktop, through the loopback sign-in", () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    setAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15");
    expect(desktopAtprotoHost()).toBe(desktopAtproto);
    expect(availableSigners(createAtprotoIdentityProvider({ host: desktopAtprotoHost }), "desktop").map(s => s.id))
      .toEqual(["atproto-oauth", "atproto-oauth-full"]);
  });
});
