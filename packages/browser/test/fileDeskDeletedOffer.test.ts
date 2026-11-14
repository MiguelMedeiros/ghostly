import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import { FileDesk } from "../src/engine/fileDesk";
import { resetFileBytes } from "../src/shared/fileBytes";
// covers: files.large.offer

afterEach(() => resetFileBytes());

/**
 * A file's message deleted here while its transfer could not say so (no session: the refusal never left) is offered
 * again by its sender on the next session. Its wire id is still among the chat's used ones for the rest of the run, and
 * that refusal ("invalid") came first: the sender read "Your contact could not take this file" with a Retry that could
 * never work. After a restart the same offer was declined. It is declined in both.
 */
it("declines an offer of a file whose message was deleted here, while its id is still in use this run", async () => {
  resetFileBytes(["idb"]);
  const sent: Record<string, unknown>[] = [];
  const desk = new FileDesk({
    send: (_link, frame) => { sent.push(frame); return true; },
    receivedBytes: () => 0,
    wireIds: () => new Set(["wDeletedFile1"]),
    deleted: (_link, messageId) => messageId === "peer_wDeletedFile1",
    messageExists: async () => false,
    storeMessage: async () => {},
    transfers: new Map(),
    changed: () => {},
  });
  desk.session("chat", true);
  await desk.handle("chat", { t: "pf-offer", id: "wDeletedFile1", name: "notes.pdf", mime: "application/pdf", size: 2048, ts: 1_700_000_000_000 });
  expect(sent.filter((frame) => frame.t === "pf-refuse")).toEqual([{ t: "pf-refuse", id: "wDeletedFile1", why: "declined" }]);
});
