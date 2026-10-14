import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsupportedBrowser } from "../../components/UnsupportedBrowser";
import { bootDetails, lockdownLikely, missingEssentials } from "../../lib/bootCheck";
import { LOCALES as locales } from "../i18n/locales";
import { englishT, translateWith } from "../../locales/translate";

// covers: app.boot

/*
 * What the web app cannot run without (lib/bootCheck), and the screen that says which is missing
 * (components/UnsupportedBrowser), drawn by the web entry instead of the app.
 */

/** An IndexedDB that answers `open` with `outcome`, or not at all. */
function fakeIndexedDb(outcome: "success" | "error" | "never" | "throws") {
  const deleted: string[] = [];
  const factory = {
    deleted,
    open: (name: string) => {
      if (outcome === "throws") throw new DOMException("denied", "SecurityError");
      const request: { result: { close(): void }; onsuccess?: () => void; onerror?: (event: Event) => void } = { result: { close: () => {} } };
      if (outcome === "success") queueMicrotask(() => request.onsuccess?.());
      if (outcome === "error") queueMicrotask(() => request.onerror?.(new Event("error")));
      void name;
      return request;
    },
    deleteDatabase: (name: string) => { deleted.push(name); },
  };
  vi.stubGlobal("indexedDB", factory);
  return factory;
}

const everything = () => {
  vi.stubGlobal("navigator", Object.create(navigator, { locks: { value: { request: () => Promise.resolve() } } }));
  return fakeIndexedDb("success");
};

afterEach(() => { vi.unstubAllGlobals(); });

describe("what the app cannot run without", () => {
  it("finds nothing missing in a browser that has it all, and leaves no database behind", async () => {
    const idb = everything();
    expect(await missingEssentials()).toEqual([]);
    expect(idb.deleted).toEqual(["ghostly-boot-check"]);
  });

  it("names Web Locks when the browser has none", async () => {
    everything();
    vi.stubGlobal("navigator", Object.create(navigator, { locks: { value: undefined } }));
    expect(await missingEssentials()).toEqual(["locks"]);
  });

  it("names IndexedDB when it is not there, when opening throws and when opening fails", async () => {
    everything();
    vi.stubGlobal("indexedDB", undefined);
    expect(await missingEssentials()).toEqual(["indexedDB"]);
    fakeIndexedDb("throws");
    expect(await missingEssentials()).toEqual(["indexedDB"]);
    fakeIndexedDb("error");
    expect(await missingEssentials()).toEqual(["indexedDB"]);
  });

  it("lets the app start when the database is only slow to open", async () => {
    everything();
    fakeIndexedDb("never");
    expect(await missingEssentials({ indexedDbWaitMs: 20 })).toEqual([]);
  });

  it("names Web Crypto where there is no crypto.subtle (an address that is not secure)", async () => {
    everything();
    vi.stubGlobal("crypto", { getRandomValues: () => new Uint8Array() });
    expect(await missingEssentials()).toEqual(["crypto"]);
  });

  it("names site data when localStorage is not there or may not be read", async () => {
    everything();
    vi.stubGlobal("localStorage", undefined);
    expect(await missingEssentials()).toEqual(["storage"]);
    vi.unstubAllGlobals();
    everything();
    const refused = vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    expect(await missingEssentials()).toEqual(["storage"]);
    refused.mockRestore();
  });

  it("lists everything missing, in one order", async () => {
    vi.stubGlobal("navigator", Object.create(navigator, { locks: { value: undefined } }));
    vi.stubGlobal("indexedDB", undefined);
    vi.stubGlobal("crypto", {});
    vi.stubGlobal("localStorage", undefined);
    expect(await missingEssentials()).toEqual(["storage", "indexedDB", "crypto", "locks"]);
  });
});

describe("Lockdown Mode, told from what is missing", () => {
  const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1";
  const IPAD_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
  const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
  const locked = { webAssembly: false, webRTC: false };

  it("is likely on an iPhone, iPad or Mac Safari without IndexedDB, Web Locks, WebAssembly and WebRTC (the friend's report)", () => {
    expect(lockdownLikely(["indexedDB", "locks"], { userAgent: IPHONE_CHROME, ...locked })).toBe(true);
    expect(lockdownLikely(["indexedDB", "locks"], { userAgent: IPAD_SAFARI, ...locked })).toBe(true);
    expect(lockdownLikely(["storage", "indexedDB", "locks"], { userAgent: IPHONE_CHROME, ...locked })).toBe(true);
  });

  it("is not, when one of the four is there", () => {
    expect(lockdownLikely(["locks"], { userAgent: IPHONE_CHROME, ...locked })).toBe(false);
    expect(lockdownLikely(["indexedDB"], { userAgent: IPHONE_CHROME, ...locked })).toBe(false);
    expect(lockdownLikely(["indexedDB", "locks"], { userAgent: IPHONE_CHROME, webAssembly: true, webRTC: false })).toBe(false);
    expect(lockdownLikely(["indexedDB", "locks"], { userAgent: IPHONE_CHROME, webAssembly: false, webRTC: true })).toBe(false);
  });

  it("is not, outside Apple's WebKit", () => {
    for (const userAgent of [MAC_CHROME, ANDROID, FIREFOX, ""]) expect(lockdownLikely(["indexedDB", "locks"], { userAgent, ...locked })).toBe(false);
  });
});

describe("the details to copy", () => {
  it("say what is missing and the error, through the boot guard's cleaning when it is there", () => {
    expect(bootDetails(["locks"], new TypeError("no lock"))).toMatch(/^missing: locks\nerror: TypeError: no lock\nbrowser: /);
    vi.stubGlobal("__ghostlyBoot", { details: () => "Ghostly boot report\nfeatures: locks=no", clean: (text: string) => text.replace(/ghostly1\w+/g, "[removed]") });
    expect(bootDetails(["indexedDB", "locks"], new Error("ghostly1secret refused"))).toBe("missing: indexedDB, locks\nerror: Error: [removed] refused\nGhostly boot report\nfeatures: locks=no");
  });
});

describe("the cannot-run screen", () => {
  it("names each missing thing and what to try, and copies the details", async () => {
    const user = userEvent.setup();
    const written: string[] = [];
    vi.stubGlobal("navigator", Object.create(navigator, { clipboard: { value: { writeText: async (text: string) => { written.push(text); } } } }));
    render(<UnsupportedBrowser missing={["indexedDB", "locks"]} details="missing: indexedDB, locks" t={englishT} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Ghostly can't run in this browser");
    expect(screen.getByTestId("unsupported-indexedDB")).toHaveTextContent("IndexedDB is off or blocked, so chats and keys can't be saved.");
    expect(screen.getByTestId("unsupported-locks")).toHaveTextContent("Web Locks is missing, so Ghostly can't make sure it runs only once.");
    expect(screen.getByRole("alert")).toHaveTextContent("open Ghostly in another one");
    expect(screen.getByTestId("unsupported-details")).toHaveValue("missing: indexedDB, locks");
    await user.click(screen.getByRole("button", { name: "Copy details" }));
    expect(written).toEqual(["missing: indexedDB, locks"]);
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("asks for the https address when only Web Crypto is missing, and speaks the language it is handed", () => {
    render(<UnsupportedBrowser missing={["crypto"]} details="" t={translateWith(locales.pt, "pt")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("O Ghostly não roda neste navegador");
    expect(screen.getByRole("alert")).toHaveTextContent("Abra o Ghostly pelo endereço https://.");
  });

  it("says Lockdown Mode is the likely reason in place of another browser, with how to exclude the site behind the ⓘ", async () => {
    const user = userEvent.setup();
    render(<UnsupportedBrowser missing={["indexedDB", "locks"]} details="" lockdown t={englishT} />);
    expect(screen.getByTestId("unsupported-lockdown")).toHaveTextContent("Lockdown Mode looks to be on");
    expect(screen.getByRole("alert")).not.toHaveTextContent("open Ghostly in another one");
    expect(screen.queryByText(/Website Settings/)).toBeNull();
    const info = screen.getByRole("button", { name: "How to turn it off for this site" });
    expect(info).toHaveAttribute("aria-expanded", "false");
    await user.click(info);
    expect(info).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Website Settings/)).toBeInTheDocument();
    expect(screen.getByText(/Configure Web Browsing/)).toBeInTheDocument();
  });

  it("says it in the language it is handed", () => {
    render(<UnsupportedBrowser missing={["indexedDB", "locks"]} details="" lockdown t={translateWith(locales.pt, "pt")} />);
    expect(screen.getByTestId("unsupported-lockdown")).toHaveTextContent("O Modo de Isolamento parece estar ligado");
  });
});
