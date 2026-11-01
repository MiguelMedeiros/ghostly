import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import type { ApiContext } from "../src/api";
import { waitForEdit, waitForGroupFrame } from "../src/waits";
// covers: headless.chat

/** A timed-out `edit --wait confirmed` and `group edit --wait sent` say what happens next, as `send`'s timeout does. */
const pending = { linkId: "chat-one", id: "me_1", text: "new", sender: "me", timestamp: 1, via: "datalink", edit: { seq: 2, pending: true } } as unknown as StoredMessage;

function fake(mode: "one-shot" | "daemon") {
  const node = { getMessage: vi.fn(async () => pending), groupTaken: vi.fn(() => 0) };
  return { runtime: { server: { node } }, mode } as unknown as ApiContext;
}

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
});
