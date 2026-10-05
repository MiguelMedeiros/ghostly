import { describe, expect, it } from "vitest";
import { PR_CHECKS, PR_STATES, STATUS_CARD_LIMITS, checkStatusCard, readStatusCard, statusCardBytes, statusCardText, type TaskCard } from "../src/statusCards";
import * as shipped from "./fixtures/statusCards-1.0.1";
// covers: chat.status-cards.wire

/*
 * The task card's optional fields (WISP 405 · Status Cards § A task): a pull request's state and checks, tags and a
 * parent. Each bound, the sender's rule, the fallback text, and what an app from before them does with such a card:
 * the reader Ghostly 1.0.1 shipped (frozen in fixtures/) shows the card exactly as it always did.
 */

const NOW = Date.UTC(2026, 9, 2, 12, 0);
const task = (extra: Record<string, unknown> = {}) => ({ kind: "task", id: "relay-rotation", title: "Fix relay rotation", status: "running", ...extra });
const pr = (extra: Record<string, unknown> = {}) => ({ url: "https://github.com/o/r/pull/612", number: 612, additions: 123, deletions: 45, ...extra });
const read = (raw: unknown) => readStatusCard(raw, NOW) as TaskCard;
const refused = (raw: unknown) => (checkStatusCard(raw, NOW) as { error?: string }).error;

describe("a pull request's state and checks", () => {
  it("are kept when they hold, one of each list", () => {
    for (const state of PR_STATES) expect(read(task({ pr: pr({ state }) })).pr).toMatchObject({ state });
    for (const checks of PR_CHECKS) expect(read(task({ pr: pr({ checks }) })).pr).toMatchObject({ checks });
    expect(PR_STATES).toEqual(["draft", "open", "merged", "closed"]);
    expect(PR_CHECKS).toEqual(["passing", "failing", "pending"]);
  });

  it("are left out when they do not hold: the pull request and the card stay", () => {
    const card = read(task({ pr: pr({ state: "approved", checks: 1 }) }));
    expect(card.pr).toEqual(pr());
    expect(card).toMatchObject({ title: "Fix relay rotation", status: "running" });
  });

  it("a sender is refused a state or checks a reader would leave out", () => {
    expect(refused(task({ pr: pr({ state: "approved" }) }))).toMatch(/pr.state is one of draft, open, merged, closed/);
    expect(refused(task({ pr: pr({ checks: "green" }) }))).toMatch(/pr.checks is one of passing, failing, pending/);
    expect(checkStatusCard(task({ pr: pr({ state: "open", checks: "passing" }) }), NOW)).toHaveProperty("card.pr.state", "open");
  });

  it("never add a status: a card with a status of its own is still dropped", () => {
    expect(readStatusCard(task({ status: "review", pr: pr({ state: "open" }) }), NOW)).toBeUndefined();
  });
});

describe("tags", () => {
  it("are up to three clean lines of at most 24 characters, none twice", () => {
    expect(STATUS_CARD_LIMITS).toMatchObject({ tags: 3, tag: 24 });
    expect(read(task({ tags: ["core", "  web  app ", "cli"] })).tags).toEqual(["core", "web app", "cli"]);
    // A reader cuts what is past the bounds and skips what is not text, an empty tag or a tag there already.
    expect(read(task({ tags: ["a", "b", "c", "d"] })).tags).toEqual(["a", "b", "c"]);
    expect(read(task({ tags: ["x".repeat(30)] })).tags).toEqual(["x".repeat(24)]);
    expect(read(task({ tags: ["a", 7, "", "a", null, "b\u202e"] })).tags).toEqual(["a", "b"]);
    expect(read(task({ tags: "core" })).tags).toBeUndefined();
    expect(read(task({ tags: [] })).tags).toBeUndefined();
  });

  it("a sender is refused what a reader would cut or skip", () => {
    expect(refused(task({ tags: ["a", "b", "c", "d"] }))).toMatch(/tags is a list of at most 3/);
    expect(refused(task({ tags: "core" }))).toMatch(/tags is a list of at most 3/);
    expect(refused(task({ tags: ["x".repeat(25)] }))).toMatch(/tags\[0\] is at most 24 characters/);
    expect(refused(task({ tags: ["core", 7] }))).toMatch(/tags\[1\] is text/);
    expect(refused(task({ tags: ["core", " core "] }))).toMatch(/tags\[1\] "core" is there twice/);
    expect(checkStatusCard(task({ tags: ["core", "web"] }), NOW)).toHaveProperty("card.tags", ["core", "web"]);
  });
});

describe("a parent", () => {
  it("is another task's id; one that is no id, or the task's own, is left out", () => {
    expect(read(task({ parent: "epic-1" })).parent).toBe("epic-1");
    expect(read(task({ parent: "-nope" })).parent).toBeUndefined();
    expect(read(task({ parent: "a".repeat(65) })).parent).toBeUndefined();
    expect(read(task({ parent: 7 })).parent).toBeUndefined();
    expect(read(task({ parent: "relay-rotation" })).parent).toBeUndefined();
  });

  it("a sender is refused a parent that is no id, or its own", () => {
    expect(refused(task({ parent: "-nope" }))).toMatch(/parent is another task's id/);
    expect(refused(task({ parent: "relay-rotation" }))).toMatch(/not its own/);
    expect(checkStatusCard(task({ parent: "epic-1" }), NOW)).toHaveProperty("card.parent", "epic-1");
  });
});

describe("the new fields within the card's bounds", () => {
  it("count toward the card's 8 KiB like every other field", () => {
    const big = task({ tags: ["a", "b", "c"], parent: "epic-1", items: Array.from({ length: 20 }, () => ({ text: "é".repeat(200) })) });
    expect(statusCardBytes(big)).toBeGreaterThan(STATUS_CARD_LIMITS.bytes);
    expect(readStatusCard(big, NOW)).toBeUndefined();
    expect(refused(big)).toMatch(/at most 8192/);
  });

  it("round-trip: what a sender may send, a reader keeps as sent", () => {
    const raw = task({ pr: pr({ state: "open", checks: "pending", files: 7 }), tags: ["core", "web"], parent: "epic-1" });
    const sent = checkStatusCard(raw, NOW);
    expect(sent).toEqual({ card: raw });
    expect(readStatusCard(JSON.parse(JSON.stringify((sent as { card: unknown }).card)), NOW)).toEqual(raw);
  });
});

describe("the fallback text", () => {
  it("says the pull request's state and checks beside it, the tags and the parent on lines of their own", () => {
    expect(statusCardText(read(task({ pr: pr({ state: "open", checks: "passing" }), tags: ["core", "web"], parent: "epic-1" })))).toBe(
      "🔄 Fix relay rotation\nRunning\nPR #612 +123 -45 (open, checks passing): https://github.com/o/r/pull/612\nTags: core, web\nPart of: epic-1");
    expect(statusCardText(read(task({ pr: pr({ state: "merged" }) })))).toBe("🔄 Fix relay rotation\nRunning\nPR #612 +123 -45 (merged): https://github.com/o/r/pull/612");
    expect(statusCardText(read(task({ pr: pr({ checks: "failing" }) })))).toBe("🔄 Fix relay rotation\nRunning\nPR #612 +123 -45 (checks failing): https://github.com/o/r/pull/612");
  });

  it("is as before for a card without them", () => {
    const raw = task({ progress: 40, done: 2, total: 5, step: "Running the e2e", pr: pr() });
    expect(statusCardText(read(raw))).toBe(shipped.statusCardText(shipped.readStatusCard(raw, NOW)!));
  });
});

describe("an app from before these fields (Ghostly 1.0.1's reader)", () => {
  const full = task({ progress: 40, done: 2, total: 5, step: "Running the e2e", branch: "fix/relay", items: [{ text: "Codec", state: "done" }],
    pr: pr({ state: "open", checks: "failing", files: 7 }), tags: ["core", "web"], parent: "epic-1", links: [{ url: "https://ci.example/run/1", label: "CI" }] });
  const before = task({ progress: 40, done: 2, total: 5, step: "Running the e2e", branch: "fix/relay", items: [{ text: "Codec", state: "done" }],
    pr: pr({ files: 7 }), links: [{ url: "https://ci.example/run/1", label: "CI" }] });

  it("still shows the card, exactly as it shows the same card without them", () => {
    const shown = shipped.readStatusCard(full, NOW);
    expect(shown).toBeDefined();
    expect(shown).toEqual(shipped.readStatusCard(before, NOW));
    expect(shown).toMatchObject({ kind: "task", title: "Fix relay rotation", status: "running", pr: pr({ files: 7 }) });
    expect(shown).not.toHaveProperty("tags");
    expect(shown).not.toHaveProperty("parent");
    expect((shown as TaskCard).pr).not.toHaveProperty("state");
  });

  it("shows it whatever the new fields hold, even nonsense: it never looks at them", () => {
    for (const extra of [{ tags: "x" }, { tags: [1, 2, 3, 4, 5] }, { parent: { id: 1 } }, { parent: "-" }, { pr: pr({ state: 9, checks: ["x"] }) }, { tags: null, parent: null }])
      expect(shipped.readStatusCard(task(extra), NOW), JSON.stringify(extra)).toMatchObject({ kind: "task", title: "Fix relay rotation", status: "running" });
  });

  it("every status a new sender may send is one it knows: there is no new status", async () => {
    const now = await import("../src/statusCards");
    expect(now.TASK_STATUSES).toEqual(shipped.TASK_STATUSES);
    expect(now.STATUS_CARD_LIMITS.bytes).toBe(shipped.STATUS_CARD_LIMITS.bytes);
  });

  it("drops a card only for the reasons it always had: the new fields are none of them", () => {
    // What it drops: no object, past 8 KiB, an unknown kind, no valid id, title or status.
    expect(shipped.readStatusCard(task({ status: "review" }), NOW)).toBeUndefined();
    expect(shipped.readStatusCard(task({ title: "" }), NOW)).toBeUndefined();
    // A card a new sender may send is never dropped by it.
    const sent = checkStatusCard(full, NOW) as { card: unknown };
    expect(shipped.readStatusCard(JSON.parse(JSON.stringify(sent.card)), NOW)).toBeDefined();
    // The fallback text a new sender writes is what it shows where it shows text.
    expect(statusCardText(read(full))).toContain("PR #612 +123 -45 (open, checks failing): https://github.com/o/r/pull/612");
  });
});
