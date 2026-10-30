import { describe, expect, it } from "vitest";
import type { StatusCard } from "@ghostly/core";
import { buttonsState, sameLabel } from "@ghostly/browser/shared/buttons";
import { replySnippet } from "@ghostly/core";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { buttonsViews, compactPresses, isButtonPress, type ButtonsRow } from "../../lib/buttons";

/*
 * agents#1703: each question read the whole history for its presses, and each press searched it for its question. A
 * 5,000-message bot chat with a question every 5 messages froze the page 88 ms per arrival (334 ms at 4x CPU).
 */

type Row = ButtonsRow & { ref?: string; file?: unknown; paymentId?: string };

const card = (n: number, once: boolean): StatusCard => ({ kind: "buttons", buttons: [{ id: "yes", label: "Yes", ...(once && { once: true }) }, { id: "no", label: "No" }], ...(n % 7 === 0 && { closed: true }) } as unknown as StatusCard);

/** A bot chat: every `every`th row a question with buttons, the next my press (sometimes typed, sometimes by its ref). */
function chat(count: number, every: number): Row[] {
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const id = `m${i}`, ref = `w${i}`;
    if (i % every === 0) { rows.push({ id, ref, sender: "peer", timestamp: i, text: `Question ${i}?`, card: card(i, i % 3 === 0) }); continue; }
    const q = i - (i % every);
    if (i % every === 1) {
      const pressed = i % 4 === 1 ? "no" : "yes";
      const byRef = i % 2 === 0;
      rows.push({ id, ref, sender: "me", timestamp: i % 11 === 0 ? i - 1 : i, text: pressed === "yes" ? "Yes" : "No",
        replyTo: { id: `w${q}`, snippet: replySnippet(`Question ${q}?`), messageId: byRef ? `gone${q}` : `m${q}`, ...(i % 5 !== 0 && { button: pressed }) } });
      continue;
    }
    rows.push({ id, ref, sender: i % 2 ? "me" : "peer", timestamp: i, text: `row ${i}` });
  }
  return rows;
}

/** The rule as it was: each question over the whole history, each press `find`ing its question. */
function before(rows: readonly Row[], refOf: (row: Row) => string | undefined) {
  const views = new Map<string, unknown>();
  for (const row of rows) {
    if (row.card?.kind !== "buttons") continue;
    const view = buttonsState(row as unknown as Pick<StoredMessage, "id" | "card" | "sender">, refOf(row), rows as unknown as Pick<StoredMessage, "sender" | "replyTo" | "timestamp" | "text">[]);
    if (view) views.set(row.id, view);
  }
  const compact = new Set<string>();
  for (const row of rows) {
    const reply = row.replyTo;
    if (!reply?.button || !isButtonPress(row)) continue;
    const question = rows.find(r => r.id === reply.messageId) ?? rows.find(r => r !== row && refOf(r) === reply.id);
    if (question?.card?.kind !== "buttons" || !question.card.buttons.some(b => b.id === reply.button && sameLabel(b.label, row.text))) continue;
    if (replySnippet(question.text) === reply.snippet) compact.add(row.id);
  }
  return { views, compact };
}

/** The rows, counting each row read through the array. */
function counted(rows: Row[]) {
  const reads = { n: 0 };
  const proxy = new Proxy(rows, { get(target, key, receiver) { if (typeof key === "string" && /^\d+$/.test(key)) reads.n++; return Reflect.get(target, key, receiver); } });
  return { rows: proxy, reads };
}

describe("a chat's buttons and presses", () => {
  it("are what reading every question against the whole history gave", () => {
    for (const every of [2, 3, 5, 20]) {
      const rows = chat(600, every), refOf = (row: Row) => row.ref;
      const was = before(rows, refOf);
      expect(buttonsViews(rows, refOf), `every ${every}`).toEqual(was.views);
      expect(compactPresses(rows, refOf), `every ${every}`).toEqual(was.compact);
      expect(was.views.size).toBeGreaterThan(0);
      expect(was.compact.size).toBeGreaterThan(0);
    }
  });

  it("read the history a few times, however many questions it has", () => {
    const { rows, reads } = counted(chat(5_000, 5));
    const views = buttonsViews(rows, row => row.ref), presses = compactPresses(rows, row => row.ref);
    console.log(`BUTTONS: 5,000 rows, ${views.size} questions, ${presses.size} compact presses, ${reads.n} row reads`);
    expect(views.size).toBe(1_000);
    expect(reads.n).toBeLessThan(5 * 5_000);
  });
});
