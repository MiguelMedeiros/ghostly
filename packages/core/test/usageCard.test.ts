import { describe, expect, it } from "vitest";
import { pairedMessageFrame } from "../src/ghostlink";
import { editFrame, parseEditFrame } from "../src/pairedEdits";
import { STATUS_CARD_LIMITS, checkStatusCard, readStatusCard, statusCardText, usageLeft, type UsageCard } from "../src/statusCards";
import * as shipped from "./fixtures/statusCards-1.0.1";
// covers: chat.status-cards.usage

/*
 * A usage card (WISP 405 § Usage): how much of a quota a bot has left. What a reader keeps of it, what a sender may
 * send, its one-line fallback text, and what an app from before the kind shows.
 */

const NOW = Date.UTC(2026, 9, 7, 12, 0);
const HOUR = 3_600_000;
const ID = "A".repeat(22);

const usage = (extra: Record<string, unknown> = {}) => ({ kind: "usage", id: "usage", left: 62, ...extra });

describe("a usage card as a reader takes it", () => {
  it("keeps every field as sent", () => {
    const raw = usage({ label: "Claude", account: "work", window: "5 h", resetsAt: NOW + 6 * HOUR, updatedAt: NOW - 60_000, used: 38, limit: 100,
      windows: [{ window: "week", left: 80, resetsAt: NOW + 72 * HOUR }] });
    expect(readStatusCard(raw, NOW)).toEqual(raw);
  });

  it("drops a card with neither a percent left nor a used of limit, or a bad id: the message shows its text", () => {
    for (const bad of [usage({ left: undefined }), usage({ left: "62" }), usage({ left: Number.NaN }), usage({ left: undefined, used: 5 }),
      usage({ left: undefined, used: 9, limit: 5 }), usage({ id: "-x" }), usage({ id: "" })])
      expect(readStatusCard(bad, NOW), JSON.stringify(bad)).toBeUndefined();
  });

  it("works the percent out from used of limit when no percent is given", () => {
    const card = readStatusCard(usage({ left: undefined, used: 380, limit: 1000 }), NOW) as UsageCard;
    expect(card).not.toHaveProperty("left");
    expect(usageLeft(card)).toBe(62);
    expect(usageLeft({ left: 3 })).toBe(3);
  });

  it("rounds and clamps the percent, cuts lines and lists, leaves out what does not hold", () => {
    const card = readStatusCard(usage({
      left: 140.6, label: "Claude‮  Max\nplan", account: "a".repeat(40), window: 5, resetsAt: NOW + 400 * 24 * HOUR, updatedAt: NOW + 3 * HOUR,
      used: 3, limit: 0, links: [{ url: "https://example.com" }],
      windows: [{ window: "week", left: -4 }, { window: "", left: 5 }, { window: "opus", left: "x" }, { window: "a", left: 1 }, { window: "b", left: 2 }, { window: "c", left: 3 }],
    }), NOW) as UsageCard;
    expect(card.left).toBe(100);
    expect(card.label).toBe("Claude Max plan");
    expect(card.account).toHaveLength(STATUS_CARD_LIMITS.usageLabel);
    expect(card).not.toHaveProperty("window");
    expect(card).not.toHaveProperty("resetsAt");
    expect(card.updatedAt).toBe(NOW + 5 * 60_000);
    expect(card).not.toHaveProperty("used");
    expect(card).not.toHaveProperty("links");
    // Of the first three, the one that holds; the rest are past the bound.
    expect(card.windows).toEqual([{ window: "week", left: 0 }]);
  });
});

describe("a usage card as a sender may send it", () => {
  it("takes one within every bound", () => {
    const raw = usage({ label: "Claude", account: "work", window: "5 h", resetsAt: NOW + HOUR, updatedAt: NOW, windows: [{ window: "week", left: 80 }] });
    expect(checkStatusCard(raw, NOW)).toEqual({ card: raw });
    expect(checkStatusCard(usage({ left: undefined, used: 1, limit: 4 }), NOW)).toHaveProperty("card");
  });

  it("refuses what a reader would drop or cut, saying why", () => {
    const refused: [Record<string, unknown>, RegExp][] = [
      [usage({ left: undefined }), /left \(a percent\) or used and limit/],
      [usage({ left: 101 }), /left is a number from 0 to 100/],
      [usage({ left: -1 }), /left is a number from 0 to 100/],
      [usage({ used: 3 }), /used and limit go together/],
      [usage({ used: 5, limit: 4 }), /used is at most limit/],
      [usage({ label: "x".repeat(25) }), /label is at most 24 characters/],
      [usage({ account: "" }), /account is text/],
      [usage({ window: "x".repeat(17) }), /window is at most 16 characters/],
      [usage({ resetsAt: NOW + 400 * 24 * HOUR }), /resetsAt is a time in milliseconds, within a year/],
      [usage({ updatedAt: NOW + HOUR }), /updatedAt is a time in milliseconds, not in the future/],
      [usage({ windows: [{ window: "a", left: 1 }, { window: "b", left: 1 }, { window: "c", left: 1 }, { window: "d", left: 1 }] }), /windows is a list of at most 3/],
      [usage({ windows: [{ window: "week" }] }), /windows\[0\]\.left is a number from 0 to 100/],
      [usage({ links: [] }), /a usage card takes no links/],
    ];
    for (const [raw, why] of refused) expect((checkStatusCard(raw, NOW) as { error: string }).error, JSON.stringify(raw)).toMatch(why);
  });
});

describe("its fallback text", () => {
  it("is one line: the label, the account, what is left of which window, when it resets, the other windows", () => {
    const card = readStatusCard(usage({ label: "Claude", account: "work", window: "5 h", resetsAt: Date.UTC(2026, 9, 7, 18, 0), windows: [{ window: "week", left: 80 }] }), NOW)!;
    expect(statusCardText(card)).toBe("📊 Claude · work · 62% left (5 h) · resets 2026-10-07 18:00 UTC · week 80%");
    expect(statusCardText(readStatusCard(usage({ left: undefined, used: 380, limit: 1000 }), NOW)!)).toBe("📊 Usage · 62% left · 380 of 1000 used");
    expect(statusCardText(card)).not.toContain("\n");
  });
});

describe("on the wire", () => {
  const card = readStatusCard(usage({ label: "Claude" }), NOW)!;

  it("rides as `sc` on paired-message, and an edit past a text's hundred holds with it", () => {
    const frame = JSON.parse(pairedMessageFrame(ID, NOW, statusCardText(card), undefined, undefined, undefined, card));
    expect(frame.sc).toEqual(card);
    const edit = JSON.parse(editFrame({ id: ID, e: 900, ts: NOW, m: statusCardText(card), sc: card }));
    expect(parseEditFrame(edit, NOW)).toMatchObject({ e: 900, sc: card });
  });
});

describe("an app from before the usage kind (Ghostly 1.0.1's reader)", () => {
  it("drops the card as a kind it does not know, and shows the one-line text", () => {
    const sent = (checkStatusCard(usage({ label: "Claude", window: "5 h" }), NOW) as { card: UsageCard }).card;
    expect(shipped.readStatusCard(JSON.parse(JSON.stringify(sent)), NOW)).toBeUndefined();
    expect(statusCardText(sent)).toBe("📊 Claude · 62% left (5 h)");
  });
});
