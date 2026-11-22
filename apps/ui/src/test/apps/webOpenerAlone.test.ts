import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onScreen } from "../../lib/apps/broker";
import { memoryHost } from "../../lib/apps/memoryHost";
import { stopRunningApps } from "../../lib/apps/open";
import { webOpener } from "../../lib/apps/webOpener";
import type { AppEntry } from "../../lib/platform";

// covers: apps.view

// Two full-screen apps opened alone (the Apps page) while one is on its way: only the one on top is live. One under
// another gets no Tab, no keys and no file sheet: it is inert and not on screen to the broker.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));
const started: string[] = [];
const running = new Map<string, { frame: HTMLIFrameElement; stop: (reason?: string) => void }>();
vi.mock("../../lib/apps/broker", async (actual) => ({
  ...(await actual<typeof import("../../lib/apps/broker")>()),
  startApp: ({ container, launch, onStop }: { container: HTMLElement; launch: { title: string }; onStop?: (reason: string) => void }) => {
    const frame = document.createElement("iframe");
    container.appendChild(frame);
    started.push(launch.title);
    let done = false;
    const stop = (reason = "stopped") => { if (done) return; done = true; frame.remove(); onStop?.(reason); };
    running.set(launch.title, { frame, stop });
    return { frame, phase: "running", stop };
  },
}));

const SLOW = "pubkeyalpha/chess";
const FAST = "pubkeyalpha/vault";
const entries: Record<string, AppEntry> = {
  [SLOW]: { ref: SLOW, digest: "c", version: "1.0.0", title: "Chess", permissions: [], entry: "<p>chess</p>", view: "full" },
  [FAST]: { ref: FAST, digest: "v", version: "1.0.0", title: "Vault", permissions: [], entry: "<p>vault</p>", view: "full" },
};

function gate(): [Promise<void>, () => void] {
  let release!: () => void;
  return [new Promise<void>((resolve) => { release = resolve; }), () => release()];
}

function opener(waits: Partial<Record<string, Promise<void>>>, refused?: Error) {
  const host = memoryHost("ghostly-app://localhost/", "ghostly-app://localhost/");
  host.entry = async (ref: string) => {
    await waits[ref];
    if (refused && ref === FAST) throw refused;
    return entries[ref]!;
  };
  return webOpener({ apps: () => host, nameIn: () => undefined, closeLabel: () => "Close" });
}

const layers = () => [...document.querySelectorAll<HTMLElement>("[data-place=alone]")];
const titleOf = (layer: HTMLElement) => layer.getAttribute("aria-label");
const inert = (node: Element) => !!node.closest("[inert]") || (node as HTMLElement).inert === true;
const closeOf = (layer: HTMLElement) => [...layer.querySelectorAll("button")].find((b) => b.textContent === "Close")!;

let shell: HTMLElement;
beforeEach(() => {
  started.length = 0;
  running.clear();
  shell = document.createElement("div");
  shell.className = "app-shell";
  document.body.appendChild(shell);
});
afterEach(() => {
  stopRunningApps();
  document.body.replaceChildren();
});

describe("two apps opened alone at once (web)", () => {
  it("the one pressed last stays; the one pressed first, finishing later, starts nothing and lands over nothing", async () => {
    const [chessFiles, release] = gate();
    const open = opener({ [SLOW]: chessFiles });
    const first = open(SLOW, null);
    await expect(open(FAST, null)).resolves.toBeUndefined();
    release();
    await expect(first).resolves.toBe("superseded");
    expect(started).toEqual(["Vault"]);
    expect(layers().map(titleOf)).toEqual(["Vault"]);
    expect(inert(layers()[0]!)).toBe(false);
    expect(onScreen(running.get("Vault")!.frame)).toBe(true);
    expect(inert(shell)).toBe(true);
  });

  it("a newer open refused meanwhile chose nothing: the older one still opens", async () => {
    const [chessFiles, release] = gate();
    const open = opener({ [SLOW]: chessFiles }, new Error("revoked: this version was revoked by its publisher"));
    const first = open(SLOW, null);
    await expect(open(FAST, null)).rejects.toThrow(/^revoked: /);
    release();
    await expect(first).resolves.toBeUndefined();
    expect(layers().map(titleOf)).toEqual(["Chess"]);
  });

  it("the older one up first, the newer one over it: the one under is inert and off screen until the top one closes", async () => {
    const [vaultFiles, letVault] = gate();
    const open = opener({ [FAST]: vaultFiles });
    const first = open(SLOW, null);
    const second = open(FAST, null);
    await expect(first).resolves.toBeUndefined();
    letVault();
    await expect(second).resolves.toBeUndefined();
    const [chess, vault] = layers();
    expect([chess, vault].map((layer) => titleOf(layer!))).toEqual(["Chess", "Vault"]);
    expect(inert(chess!)).toBe(true);
    expect(onScreen(running.get("Chess")!.frame)).toBe(false);
    expect(inert(vault!)).toBe(false);
    expect(onScreen(running.get("Vault")!.frame)).toBe(true);

    closeOf(vault!).click();
    expect(layers().map(titleOf)).toEqual(["Chess"]);
    expect(inert(chess!)).toBe(false);
    expect(onScreen(running.get("Chess")!.frame)).toBe(true);
    expect(inert(shell)).toBe(true);
    closeOf(chess!).click();
    expect(layers()).toEqual([]);
    expect(inert(shell)).toBe(false);
  });

  it("the one under goes first (stopped on its own): the page stays inert until the one on top closes", async () => {
    const open = opener({});
    await open(SLOW, null);
    await open(FAST, null);
    running.get("Chess")!.stop("stopped");
    expect(layers().map(titleOf)).toEqual(["Vault"]);
    expect(inert(shell)).toBe(true);
    closeOf(layers()[0]!).click();
    expect(layers()).toEqual([]);
    expect(inert(shell)).toBe(false);
  });
});
