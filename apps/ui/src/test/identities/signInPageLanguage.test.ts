import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { desktopAtproto } from "../../desktop/atproto";
import { desktopOidc } from "../../desktop/oidc";

// covers: proofs.oidc.callback.desktop, proofs.atproto.oauth

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/*
 * After a sign-in in the system browser, the browser lands on a page Rust's loopback listener serves. Rust holds its
 * words in the app's languages; the app names which one when the sign-in starts.
 */

const lang = document.documentElement.lang;

afterEach(() => {
  document.documentElement.lang = lang;
  vi.mocked(invoke).mockReset();
});

describe("the page a Desktop sign-in comes back to", () => {
  it.each([
    ["OpenID Connect", desktopOidc],
    ["AT Protocol", desktopAtproto],
  ])("is asked for in the app's language (%s)", async (_name, host) => {
    document.documentElement.lang = "pt-BR";
    vi.mocked(invoke).mockResolvedValue(47501);
    await host.open();
    expect(invoke).toHaveBeenCalledWith("oidc_loopback_start", { lang: "pt-BR" });
  });

  it("is asked for in the system's language while the app has named none", async () => {
    document.documentElement.lang = "";
    vi.mocked(invoke).mockResolvedValue(47501);
    await desktopOidc.open();
    expect(invoke).toHaveBeenCalledWith("oidc_loopback_start", { lang: navigator.language });
  });
});
