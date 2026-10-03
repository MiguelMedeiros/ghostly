import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnsupportedBrowser } from "../../components/UnsupportedBrowser";
import { bootDetails, missingEssentials } from "../../lib/bootCheck";
import { locales } from "../../locales";
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
});
