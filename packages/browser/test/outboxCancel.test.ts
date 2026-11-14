import { afterEach, describe, expect, it, vi } from "vitest";
import { NotSent, Outbox } from "../src/engine/outbox";
import type { StoredMessage } from "../src/shared/types";
// covers: chat.waiting, chat.paired.delete-message

/*
 * Cancel sending on a waiting text, as the outbox's retry of it runs. The retry reads the row, marks it `sending` and
 * hands the copy it read to the link; a Cancel that deleted the row anywhere in between used to change nothing: the text
 * went, and the row's marks fell on nothing. Now the outbox is told (`cancel`): before the hand-off the text never goes,
 * after it the answer says it may be out, so the caller removes it from the contact too.
 */

afterEach(() => vi.useRealTimers());

const WIRES = ["aaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccc"];
type Hook = "before-mark" | "after-mark" | "send";

/** Texts no relay took (`waiting`), in the engine's store kept in memory, and the hooks a Cancel is fired from. */
function chat(count = 1, delivery: "waiting" | "queued" = "waiting") {
  const rows = new Map<string, StoredMessage>();
  for (let i = 0; i < count; i++) {
    const wireId = WIRES[i];
    rows.set(`me_${wireId}`, { linkId: "memory", id: `me_${wireId}`, wireId, text: `text ${i + 1}`, sender: "me", timestamp: i + 1, via: "pkarr",
      delivery, deliveryError: delivery === "waiting" ? NotSent.REASON : "Not confirmed yet.", resendUntil: Date.now() + 86_400_000 });
  }
  const hooks: Partial<Record<Hook, (id: string) => void>> = {};
  const writes: [string, string][] = [];
  const store = {
    read: async () => [...rows.values()].map(row => ({ ...row })),
    get: async (id: string) => { const row = rows.get(id); return row && { ...row }; },
    getMany: async (ids: string[]) => ids.map(id => { const row = rows.get(id); return row && { ...row }; }),
    update: async (id: string, state: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
      if (state === "sending") hooks["before-mark"]?.(id);
      // As `db.updateDelivery`: a row deleted meanwhile is not brought back.
      const row = rows.get(id);
      if (row) { writes.push([id, state]); Object.assign(row, extra, { delivery: state, deliveryError: error }); }
      if (state === "sending") hooks["after-mark"]?.(id);
    },
  };
  const sent: string[] = [];
  const send = vi.fn(async (message: StoredMessage) => { hooks.send?.(message.id); sent.push(message.text); return null; });
  const box = new Outbox(store, send, 20_000, undefined, { resender: { ready: () => true, via: () => "pkarr" }, policy: { backoffMs: [5_000] } });
  /** Cancel sending: the row goes, and the outbox is told, at once (the engine's `deleteMessage`). */
  const cancel = (id: string) => { const out = box.cancel(id); rows.delete(id); return out; };
  return { rows, hooks, writes, sent, send, box, cancel, ids: [...rows.keys()] };
}

describe("Cancel sending as the outbox's retry of the waiting text runs", () => {
  for (const when of ["before-mark", "after-mark"] as const) {
    it(`${when}: the text never goes, and nothing of it is retried`, async () => {
      vi.useFakeTimers();
      const t = chat();
      const [id] = t.ids;
      let out: boolean | undefined;
      t.hooks[when] = cancelled => { if (cancelled === id && out === undefined) out = t.cancel(id); };
      await t.box.recover();
      // The retry: its check comes due and reads the row it is about to send.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(out).toBe(false);
      expect(t.send).not.toHaveBeenCalled();
      // No check, receipt timeout or backoff brings it back.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(t.send).not.toHaveBeenCalled();
      expect(t.rows.has(id)).toBe(false);
      await t.box.stop();
    });
  }

  it("as it is handed to the link: it may be out, so the answer says so, and it is neither marked nor sent again", async () => {
    vi.useFakeTimers();
    const t = chat();
    const [id] = t.ids;
    let out: boolean | undefined;
    t.hooks.send = handed => { if (handed === id && out === undefined) out = t.cancel(id); };
    await t.box.recover();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(out).toBe(true);
    expect(t.sent).toEqual(["text 1"]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.send).toHaveBeenCalledTimes(1);
    // The mark before the hand-off is the last: no `sent`, no `queued` after its receipt timeout.
    expect(t.writes).toEqual([[id, "sending"]]);
    await t.box.stop();
  });

  it("a queued text (it went before) deleted as its resend goes: the answer is false, a delete here stays one", async () => {
    vi.useFakeTimers();
    const t = chat(1, "queued");
    const [id] = t.ids;
    let out: boolean | undefined;
    t.hooks.send = handed => { if (handed === id && out === undefined) out = t.cancel(id); };
    await t.box.recover();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(out).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.send).toHaveBeenCalledTimes(1);
    await t.box.stop();
  });

  it("at a quiet moment: nothing is handed, the answer is false, and it never goes", async () => {
    vi.useFakeTimers();
    const t = chat();
    await t.box.recover();
    expect(t.cancel(t.ids[0])).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.send).not.toHaveBeenCalled();
    await t.box.stop();
  });

  it("the middle one of three cancelled as the first's retry is marked: the other two go, in order, once each", async () => {
    vi.useFakeTimers();
    const t = chat(3);
    const [first, middle, last] = t.ids;
    let out: boolean | undefined;
    t.hooks["after-mark"] = marked => { if (marked === first && out === undefined) out = t.cancel(middle); };
    await t.box.recover();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(out).toBe(false);
    expect(t.sent).toEqual(["text 1", "text 3"]);
    expect(t.writes.filter(([id]) => id === last).map(([, state]) => state)[0]).toBe("sending");
    expect(t.rows.has(middle)).toBe(false);
    await t.box.stop();
  });

  it("a send under way of another text is not taken for this one's", async () => {
    vi.useFakeTimers();
    const t = chat(2);
    const [first, second] = t.ids;
    let out: boolean | undefined;
    t.hooks.send = handed => { if (handed === first && out === undefined) out = t.cancel(second); };
    await t.box.recover();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(out).toBe(false);
    expect(t.sent).toEqual(["text 1"]);
    await t.box.stop();
  });
});
