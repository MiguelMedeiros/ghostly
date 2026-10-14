import { afterEach, describe, expect, it, vi } from "vitest";

// covers: desktop.local-fetch

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  listen: async () => () => {},
  getIdentifier: async () => "tools.ghostly.app",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));
// The options the host is made with, as they are.
vi.mock("@ghostly/browser/inPageHost", () => ({ createInPageHost: (options: unknown) => options }));

import { invoke } from "@tauri-apps/api/core";
import type { LocalFetch } from "@ghostly/core";
import { createDesktopHost } from "../../desktop/host";
import { applyDocumentLanguage } from "../../lib/documentLanguage";

/*
 * Sharing a local app asks in a native dialog that Rust draws and words itself (apps/desktop/src/local_access.rs):
 * the page can neither write nor answer it. The page says only which language it is shown in, at the moment it asks,
 * so the dialog is in the profile's language and not in English for everyone.
 */

const called = vi.mocked(invoke) as unknown as ReturnType<typeof vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>>;
type Host = { requestLocalAccess(pattern: string, origin: string): Promise<boolean>; node: { localFetch: LocalFetch } };
const host = () => createDesktopHost("1.2.0") as unknown as Host;
const argsOf = (command: string) => called.mock.calls.filter(([name]) => name === command).map(([, args]) => args!);

afterEach(() => {
  called.mockReset();
  called.mockImplementation(async () => undefined);
  applyDocumentLanguage("en");
});

describe("the native dialog for a local app is asked for in the page's language", () => {
  it("when the person shares one", async () => {
    const desktop = host();
    called.mockImplementation(async (command) => (command === "local_service_allow" ? true : undefined));
    applyDocumentLanguage("pt");
    expect(await desktop.requestLocalAccess("http://localhost/*", "http://localhost:3400")).toBe(true);
    // The language of now, not of when the app started.
    applyDocumentLanguage("ar");
    await desktop.requestLocalAccess("http://localhost/*", "http://localhost:3401");
    expect(argsOf("local_service_allow")).toEqual([
      expect.objectContaining({ origin: "http://localhost:3400", lang: "pt-BR" }),
      expect.objectContaining({ origin: "http://localhost:3401", lang: "ar" }),
    ]);
  });

  it("when a contact's request is the first for an address", async () => {
    const desktop = host();
    called.mockImplementation(async (command) => (command === "local_fetch" ? { status: 204, headers: [], body_b64: "" } : undefined));
    applyDocumentLanguage("ja");
    const answer = await desktop.node.localFetch({ url: "http://localhost:3400/", method: "GET", headers: [], body: null, signal: new AbortController().signal });
    expect(answer.status).toBe(204);
    expect(argsOf("local_fetch")).toEqual([expect.objectContaining({ url: "http://localhost:3400/", lang: "ja" })]);
  });
});
