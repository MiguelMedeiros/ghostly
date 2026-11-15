import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryHost } from "../../lib/apps/memoryHost";
import { stopRunningApps } from "../../lib/apps/open";
import { chatApp, noteChoice, registerAppSlot, updateChatApp } from "../../lib/apps/running";
import { webOpener } from "../../lib/apps/webOpener";
import type { AppEntry } from "../../lib/platform";

// covers: apps.view

// Two Opens in one chat on their way at once (each app card has its own; a card, then + → Apps): the one asked first
// is slow (its files downloading on a restored profile), the one asked last shows and the person uses it. The slow
// one finishing later must not stop it and take its place.
vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));
const started: string[] = [];
const stopped: string[] = [];
vi.mock("../../lib/apps/broker", async (actual) => ({
  ...(await actual<typeof import("../../lib/apps/broker")>()),
  startApp: ({ container, launch, onStop }: { container: HTMLElement; launch: { title: string }; onStop?: (reason: string) => void }) => {
    const frame = document.createElement("iframe");
    container.appendChild(frame);
    started.push(launch.title);
    let done = false;
    const stop = () => { if (done) return; done = true; frame.remove(); stopped.push(launch.title); onStop?.("stopped"); };
    return { frame, phase: "running", stop };
  },
}));

const LINK = "link-1";
const SLOW = "pubkeyalpha/chess";
const FAST = "pubkeyalpha/notes";
const entries: Record<string, AppEntry> = {
  [SLOW]: { ref: SLOW, digest: "c", version: "1.0.0", title: "Chess", permissions: ["chat"], entry: "<p>chess</p>" },
  [FAST]: { ref: FAST, digest: "n", version: "1.0.0", title: "Notes", permissions: ["chat"], entry: "<p>notes</p>" },
};

function opener(slowFiles: Promise<void>) {
  const host = memoryHost("ghostly-app://localhost/", "ghostly-app://localhost/");
  host.entry = async (ref: string) => { if (ref === SLOW) await slowFiles; return entries[ref]!; };
  return webOpener({ apps: () => host, nameIn: () => undefined, closeLabel: () => "Close" });
}

beforeEach(() => {
  started.length = 0;
  stopped.length = 0;
  registerAppSlot(LINK, { box: document.createElement("div"), sessionId: "s1", contact: { name: "Bob", named: true } });
});
afterEach(() => {
  stopRunningApps();
  registerAppSlot(LINK, null);
});

describe("two apps opened in one chat at once (web)", () => {
  it("the one asked last stays when the one asked first finishes later; the older one starts nothing", async () => {
    let release!: () => void;
    const open = opener(new Promise<void>((resolve) => { release = resolve; }));
    const first = open(SLOW, LINK);
    await expect(open(FAST, LINK)).resolves.toBeUndefined();
    expect(chatApp(LINK)?.ref).toBe(FAST);
    release();
    // Nothing new started: the contact is not told it opened.
    await expect(first).resolves.toBe("shown");
    expect(started).toEqual(["Notes"]);
    expect(stopped).toEqual([]);
    expect(chatApp(LINK)?.ref).toBe(FAST);
    expect(chatApp(LINK)?.stopped).toBeUndefined();
  });

  it("Back to the app already running there (the resume bar) is the newest choice: a slower Open finishing later starts nothing", async () => {
    let release!: () => void;
    const open = opener(new Promise<void>((resolve) => { release = resolve; }));
    // Notes runs in the chat, and the person went Back from it.
    await open(FAST, LINK);
    updateChatApp(LINK, { shown: false });
    // Open on Chess's card (its files downloading), then "Back to Notes" (ChatAppResume) while it is on its way.
    const late = open(SLOW, LINK);
    noteChoice(LINK);
    updateChatApp(LINK, { shown: true });
    release();
    const result = await late;
    expect(started).toEqual(["Notes"]);
    expect(stopped).toEqual([]);
    expect(result).toBe("shown");
    expect(chatApp(LINK)?.ref).toBe(FAST);
    expect(chatApp(LINK)?.shown).toBe(true);
    expect(chatApp(LINK)?.stopped).toBeUndefined();
  });

  it("asked one after the other, each finishing in turn: the newer one takes the older one's place", async () => {
    const open = opener(Promise.resolve());
    await open(SLOW, LINK);
    await open(FAST, LINK);
    expect(started).toEqual(["Chess", "Notes"]);
    expect(stopped).toEqual(["Chess"]);
    expect(chatApp(LINK)?.ref).toBe(FAST);
  });
});
