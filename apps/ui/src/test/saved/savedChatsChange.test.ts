import { describe, expect, it } from "vitest";
import type { EngineState } from "@ghostly/browser/shared/types";
import { chatsChange } from "../../hooks/useSavedMessages";
import { groupView, linkView } from "../fakeEngine";

// covers: chat.saved

/**
 * The saved messages' store asks again when a chat or a group comes or goes. It checks each engine state against the
 * ids it holds without building a set; this holds it to the sets it built before, kept here as they were.
 */
const chatIds = (state: EngineState | null) => new Set([...state?.links.map((l) => l.id) ?? [], ...state?.groups.map((g) => `group:${g.id}`) ?? []]);
const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id));

/** What the store did before, state by state: whether it asks again. */
function before(first: EngineState | null): (next: EngineState | null) => boolean {
  let ids = chatIds(first);
  return (next) => {
    const now = chatIds(next);
    if (sameIds(now, ids)) return false;
    ids = now;
    return true;
  };
}

/** A state with these chats and groups, as new objects each time, as the engine sends them (the rest left out). */
const state = (links: string[], groups: string[]) => ({ links: links.map((id) => linkView({ id })), groups: groups.map((id) => groupView({ id })) }) as EngineState;

/** Both checks over the same states, in order: what each said at each step. */
function both(states: (EngineState | null)[]): { was: boolean[]; now: boolean[] } {
  const old = before(states[0]), changed = chatsChange(states[0]);
  const rest = states.slice(1);
  return { was: rest.map((s) => old(s)), now: rest.map((s) => changed(s)) };
}

// A small seeded generator: the same rounds on every run.
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the saved messages' check of the chats and groups", () => {
  it("says what the sets said in each case", () => {
    const cases: [string, (EngineState | null)[], boolean[]][] = [
      ["the same, as new objects", [state(["a", "b"], ["g"]), state(["a", "b"], ["g"])], [false]],
      ["a group moving up the list", [state(["a"], ["g", "h"]), state(["a"], ["h", "g"])], [false]],
      ["chats in another order, then in it again", [state(["a", "b", "c"], []), state(["c", "a", "b"], []), state(["c", "a", "b"], []), state(["a", "b", "c"], [])], [false, false, false]],
      ["a chat coming", [state(["a"], ["g"]), state(["a", "b"], ["g"])], [true]],
      ["a chat going", [state(["a", "b"], ["g"]), state(["a"], ["g"])], [true]],
      ["a group coming", [state(["a"], []), state(["a"], ["g"])], [true]],
      ["a group going", [state(["a"], ["g"]), state(["a"], [])], [true]],
      ["a chat for another, as many", [state(["a", "b"], ["g"]), state(["a", "c"], ["g"])], [true]],
      ["a chat for a group, as many", [state(["a", "b"], ["g"]), state(["a"], ["g", "h"])], [true]],
      ["a chat twice instead of another", [state(["a", "b"], []), state(["a", "a"], [])], [true]],
      ["a chat twice, then once", [state(["a", "a"], []), state(["a"], []), state(["a", "a"], [])], [false, false]],
      ["a chat whose id is a group's", [state(["group:g"], []), state([], ["g"]), state(["group:g"], ["g"])], [false, false]],
      ["another profile", [state(["a", "b"], ["g"]), state(["x", "y"], ["h"]), state(["x", "y"], ["h"])], [true, false]],
      ["no state, then an empty one", [null, state([], []), null], [false, false]],
      ["no state, then chats", [null, state(["a"], []), null], [true, true]],
    ];
    for (const [name, states, asks] of cases) {
      const { was, now } = both(states);
      expect(was, name).toEqual(asks);
      expect(now, name).toEqual(was);
    }
  });

  it("says what the sets said over random chats and groups coming, going, swapped and repeated", () => {
    const next = random(8067);
    const pick = <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)];
    // Few ids, so steps meet again what was held: `group:g1` as a chat's id meets the group g1.
    const linkIds = ["a", "b", "c", "d", "e", "group:g1"], groupIds = ["g1", "g2", "g3", "g4"];
    let steps = 0, asks = 0;
    for (let round = 0; round < 1000; round++) {
      let links = linkIds.filter(() => next() < 0.5), groups = groupIds.filter(() => next() < 0.5);
      const states: (EngineState | null)[] = [state(links, groups)];
      for (let step = 0; step < 30; step++) {
        const r = next();
        if (r < 0.2) { /* the same */ }
        else if (r < 0.3) links = [...links, pick(linkIds)];
        else if (r < 0.4) links = links.filter((_, i) => i !== Math.floor(next() * links.length));
        else if (r < 0.5) groups = [...groups, pick(groupIds)];
        else if (r < 0.6) groups = groups.filter((_, i) => i !== Math.floor(next() * groups.length));
        else if (r < 0.7 && links.length) links = links.map((id, i) => i === Math.floor(next() * links.length) ? pick(linkIds) : id);
        else if (r < 0.8 && groups.length) groups = groups.map((id, i) => i === Math.floor(next() * groups.length) ? pick(groupIds) : id);
        else if (r < 0.9) { links = [...links].sort(() => next() - 0.5); groups = [...groups].sort(() => next() - 0.5); }
        else if (r < 0.95) { links = linkIds.filter(() => next() < 0.5); groups = groupIds.filter(() => next() < 0.5); }
        else { states.push(null); continue; }
        states.push(state(links, groups));
      }
      const { was, now } = both(states);
      expect(now, `round ${round}`).toEqual(was);
      steps += was.length;
      asks += was.filter(Boolean).length;
    }
    // Both kinds of answer were checked many times.
    expect(steps).toBe(30_000);
    expect(asks).toBeGreaterThan(5_000);
    expect(steps - asks).toBeGreaterThan(5_000);
  });
});
