import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryHost } from "../../lib/apps/memoryHost";
import { stopAppsIn, stopRunningApps } from "../../lib/apps/open";
import { chatApp, registerAppSlot } from "../../lib/apps/running";
import { webOpener } from "../../lib/apps/webOpener";
import type { AppEntry } from "../../lib/platform";

// covers: apps.view chat.paired.block

// The contact blocked (Chat.tsx's `stopAppsIn`): the web's apps with them stop, in the chat's panel and full screen
// alike; an app with another contact, or alone, goes on.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));
const stopped: string[] = [];
vi.mock("../../lib/apps/broker", async (actual) => ({
  ...(await actual<typeof import("../../lib/apps/broker")>()),
  startApp: ({ container, launch, onStop }: { container: HTMLElement; launch: { title: string; chat: { linkId: string } | null }; onStop?: (reason: string) => void }) => {
    const frame = document.createElement("iframe");
    container.appendChild(frame);
    let done = false;
    const stop = () => { if (done) return; done = true; frame.remove(); stopped.push(`${launch.title} ${launch.chat?.linkId ?? "alone"}`); onStop?.("stopped"); };
    return { frame, phase: "running", stop };
  },
}));

const entry = (ref: string, title: string, view: "chat" | "full"): AppEntry => ({ ref, digest: "d", version: "1.0.0", title, permissions: ["chat"], view, entry: "<p>app</p>" });
const APPS: Record<string, AppEntry> = { "k/notes": entry("k/notes", "Notes", "chat"), "k/cinema": entry("k/cinema", "Cinema", "full") };
const open = webOpener({
  apps: () => { const host = memoryHost("ghostly-app://localhost/", "ghostly-app://localhost/"); host.entry = async (ref) => APPS[ref]!; return host; },
  nameIn: () => "Bob", closeLabel: () => "Close",
});
const slot = (name: string) => ({ box: document.createElement("div"), sessionId: name, contact: { name, named: true } });

beforeEach(() => {
  stopped.length = 0;
  registerAppSlot("link-bob", slot("Bob"));
  registerAppSlot("link-eve", slot("Eve"));
});
afterEach(() => {
  stopRunningApps();
  registerAppSlot("link-bob", null);
  registerAppSlot("link-eve", null);
  document.querySelectorAll("[data-place=alone]").forEach((node) => node.remove());
});

describe("a blocked contact's apps on the web", () => {
  it("in the chat's panel: it stops, and another chat's app goes on", async () => {
    await open("k/notes", "link-bob");
    await open("k/notes", "link-eve");
    stopAppsIn("link-bob");
    expect(stopped).toEqual(["Notes link-bob"]);
    expect(chatApp("link-bob")).toBeUndefined();
    expect(chatApp("link-eve")?.ref).toBe("k/notes");
  });

  it("full screen with them: it stops, and one alone goes on", async () => {
    await open("k/cinema", "link-bob");
    await open("k/cinema", null);
    stopAppsIn("link-bob");
    expect(stopped).toEqual(["Cinema link-bob"]);
  });
});
