import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryHost } from "../../lib/apps/memoryHost";
import { stopRunningApps } from "../../lib/apps/open";
import { chatApp, noteChoice, registerAppSlot, updateChatApp } from "../../lib/apps/running";
import { runnerPolicy } from "../../lib/apps/runnerCheck";
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

/** `slowFiles`: Chess's files downloading. `notes`: Notes's own wait, and how its entry read is refused, if it is. */
function opener(slowFiles: Promise<void>, notes: { wait?: Promise<void>; refused?: Error } = {}) {
  const host = memoryHost("ghostly-app://localhost/", "ghostly-app://localhost/");
  host.entry = async (ref: string) => {
    if (ref === SLOW) await slowFiles;
    if (ref === FAST) { await notes.wait; if (notes.refused) throw notes.refused; }
    return entries[ref]!;
  };
  return webOpener({ apps: () => host, nameIn: () => undefined, closeLabel: () => "Close" });
}

function gate(): [Promise<void>, () => void] {
  let release!: () => void;
  return [new Promise<void>((resolve) => { release = resolve; }), () => release()];
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

  // A newer Open that is refused (its card says why) is no choice of what runs there: the older one still on its way
  // opens once its files are in, rather than stopping with no app and nothing said.
  it("a newer Open refused (revoked) while the older one is on its way: the older one opens", async () => {
    const [files, release] = gate();
    const open = opener(files, { refused: new Error("revoked: this version was revoked by its publisher") });
    const first = open(SLOW, LINK);
    await expect(open(FAST, LINK)).rejects.toThrow(/^revoked: /);
    release();
    await expect(first).resolves.toBeUndefined();
    expect(started).toEqual(["Chess"]);
    expect(chatApp(LINK)?.ref).toBe(SLOW);
    expect(chatApp(LINK)?.stopped).toBeUndefined();
  });

  it("a newer Open refused (its runner could not be reached) while the older one is on its way: the older one opens", async () => {
    vi.mocked(runnerPolicy).mockResolvedValueOnce(null);
    const [files, release] = gate();
    const open = opener(files);
    const first = open(SLOW, LINK);
    await expect(open(FAST, LINK)).rejects.toThrow(/^offline: /);
    release();
    await expect(first).resolves.toBeUndefined();
    expect(started).toEqual(["Chess"]);
    expect(chatApp(LINK)?.ref).toBe(SLOW);
  });

  it("the older Open finishes while the newer one is still checked, and the newer one is then refused: the older one stays", async () => {
    const [notesWait, letNotes] = gate();
    const open = opener(Promise.resolve(), { wait: notesWait, refused: new Error("revoked: this version was revoked by its publisher") });
    const first = open(SLOW, LINK);
    const second = open(FAST, LINK);
    await expect(first).resolves.toBeUndefined();
    expect(chatApp(LINK)?.ref).toBe(SLOW);
    letNotes();
    await expect(second).rejects.toThrow(/^revoked: /);
    expect(started).toEqual(["Chess"]);
    expect(stopped).toEqual([]);
    expect(chatApp(LINK)?.ref).toBe(SLOW);
  });

  it("the older Open finishes while the newer one is still checked, and the newer one then opens: it takes the older one's place", async () => {
    const [notesWait, letNotes] = gate();
    const open = opener(Promise.resolve(), { wait: notesWait });
    const first = open(SLOW, LINK);
    const second = open(FAST, LINK);
    await expect(first).resolves.toBeUndefined();
    letNotes();
    await expect(second).resolves.toBeUndefined();
    expect(started).toEqual(["Chess", "Notes"]);
    expect(stopped).toEqual(["Chess"]);
    expect(chatApp(LINK)?.ref).toBe(FAST);
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
