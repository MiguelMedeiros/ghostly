import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import type { ApiContext } from "../src/api";
import { waitForConfirmed, waitForEdit, waitForGroupFrame, waitForRemoval } from "../src/waits";
// covers: headless.chat

/** A timed-out `edit --wait confirmed` and `group edit --wait sent` say what happens next, as `send`'s timeout does. */
const pending = { linkId: "chat-one", id: "me_1", text: "new", sender: "me", timestamp: 1, via: "datalink", edit: { seq: 2, pending: true } } as unknown as StoredMessage;

function fake(mode: "one-shot" | "daemon", links: unknown[] = [], groups?: unknown[]) {
  const node = {
    getMessage: vi.fn(async () => pending), groupTaken: vi.fn(() => 0), removalPending: vi.fn(() => true),
    chatUnconfirmed: vi.fn(() => ({ reactions: [1], pin: null })), getState: () => ({ links, groups }),
  };
  return { runtime: { server: { node } }, mode } as unknown as ApiContext;
}

/** A chat of mine whose invite nobody took yet. */
const unjoined = { id: "chat-one", profile: "default", inviteCode: "ghostly1-code" };

async function timedOut(wait: Promise<unknown>) {
  const caught = wait.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(31_000);
  return caught;
}

afterEach(() => { vi.useRealTimers(); });

describe("an edit's timeout", () => {
  it("in a one-shot names the next step, not a profile it is closing", async () => {
    vi.useFakeTimers();
    expect(await timedOut(waitForEdit(fake("one-shot"), "chat-one", "me_1", 30_000))).toMatchObject({
      code: "timeout", details: { messageId: "me_1", edits: 2 },
      message: "Timed out after 30 s: the contact has not confirmed the edit yet (it needs a live chat and a contact's app that shows edits). It goes with this profile's next command, or keep it online with `ghostly daemon --detach`",
    });
    expect(await timedOut(waitForGroupFrame(fake("one-shot"), "g1", "mine:0:2", 2, 30_000))).toMatchObject({
      code: "timeout", details: { messageId: "mine:0:2", edits: 2 },
      message: "Timed out after 30 s: no member's edge took it yet (it stays in the group and goes when one opens). It goes with this profile's next command, or keep it online with `ghostly daemon --detach`",
    });
  });

  it("in a daemon says it still goes by itself", async () => {
    vi.useFakeTimers();
    expect(await timedOut(waitForEdit(fake("daemon"), "chat-one", "me_1", 30_000))).toMatchObject({
      message: "Timed out after 30 s: the contact has not confirmed the edit yet (it needs a live chat and a contact's app that shows edits). It still goes by itself while this profile is online",
    });
    expect(await timedOut(waitForGroupFrame(fake("daemon"), "g1", "mine:0:2", undefined, 30_000))).toMatchObject({
      message: "Timed out after 30 s: no member's edge took it yet (it stays in the group and goes when one opens). It still goes by itself while this profile is online",
    });
  });

  // It said "goes with this profile's next command": nothing goes to a chat nobody joined before they do.
  it("on a chat nobody joined yet says it goes once the contact joins", async () => {
    vi.useFakeTimers();
    expect(await timedOut(waitForEdit(fake("one-shot", [unjoined]), "chat-one", "me_1", 30_000))).toMatchObject({
      message: "Timed out after 30 s: the contact has not confirmed the edit yet (it needs a live chat and a contact's app that shows edits). It goes once the contact joins this chat (nobody has yet) while this profile is online (`ghostly daemon --detach`)",
    });
    expect(await timedOut(waitForConfirmed(fake("daemon", [unjoined]), "chat-one", "reaction", (left) => left.reactions.length > 0, 30_000))).toMatchObject({
      message: "Timed out after 30 s: the contact has not confirmed the reaction yet. It is kept here and goes once the contact joins this chat (nobody has yet)",
    });
  });
});

/**
 * NTP or a person sets the wall clock back while a `--wait … --timeout 5` waits: the wait still ends 5 s after it
 * began. It counted on `Date.now()`, ran 65 s, and the client's own deadline told the bot to restart a sound daemon.
 */
describe("a wait's timeout with the wall clock set back", () => {
  const waits: [string, (ctx: ApiContext) => Promise<unknown>][] = [
    ["edit", (ctx) => waitForEdit(ctx, "chat-one", "me_1", 5_000)],
    ["removal", (ctx) => waitForRemoval(ctx, "chat-one", "me_1", 5_000)],
    ["group frame", (ctx) => waitForGroupFrame(ctx, "g1", "mine:0:2", undefined, 5_000)],
    ["reaction", (ctx) => waitForConfirmed(ctx, "chat-one", "reaction", (left) => left.reactions.length > 0, 5_000)],
  ];
  it.each(waits)("%s ends on time", async (_, wait) => {
    vi.useFakeTimers();
    let error: unknown;
    void wait(fake("daemon")).catch((caught: unknown) => { error = caught; });
    await vi.advanceTimersByTimeAsync(2_000);
    vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(error).toMatchObject({ code: "timeout" });
  });
});

describe("a group frame's wait", () => {
  const me = { key: "mine", me: true }, ana = { key: "ana", me: false };
  const crew = (profile: string, members: unknown[]) => [{ id: "g1", profile, members }];

  // Nothing sent there reaches anyone, not even a member who joins later: it sat its whole wait, said "it goes when one
  // opens" and exited 4, which a bot retries, sending it again.
  it("answers 0 at once in a private group with nobody else in it", async () => {
    vi.useFakeTimers();
    for (const which of [undefined, 2, { reaction: 1 }, { pin: 1 }]) {
      await expect(waitForGroupFrame(fake("one-shot", [], crew("mesh", [me])), "g1", "mine:0:2", which, 30_000)).resolves.toBe(0);
    }
    await expect(waitForGroupFrame(fake("daemon", [], crew("mesh", [me])), "g1", "mine:0:2", undefined, 30_000)).resolves.toBe(0);
  });

  it("still waits with another member in it, and in a community, whose roster may not list everyone yet", async () => {
    vi.useFakeTimers();
    expect(await timedOut(waitForGroupFrame(fake("daemon", [], crew("mesh", [me, ana])), "g1", "mine:0:2", undefined, 30_000))).toMatchObject({ code: "timeout" });
    expect(await timedOut(waitForGroupFrame(fake("daemon", [], crew("community", [me])), "g1", "mine:0:2", undefined, 30_000))).toMatchObject({ code: "timeout" });
  });

  it("ends when the last other member leaves while it waits", async () => {
    vi.useFakeTimers();
    const groups = crew("mesh", [me, ana]);
    const wait = waitForGroupFrame(fake("daemon", [], groups), "g1", "mine:0:2", undefined, 30_000);
    await vi.advanceTimersByTimeAsync(1_000);
    (groups[0] as { members: unknown[] }).members = [me];
    await vi.advanceTimersByTimeAsync(500);
    await expect(wait).resolves.toBe(0);
  });
});
