import { describe, expect, it } from "vitest";
import { completable, generate, missing, scenarioId, type Constraint, type Dimension } from "./pairwise";

const dim = (id: string, ...values: string[]): Dimension => ({ id, label: id, values: values.map((v) => ({ id: v })) });

describe("pairwise generation", () => {
  const dimensions = [dim("a", "a1", "a2", "a3"), dim("b", "b1", "b2", "b3"), dim("c", "c1", "c2"), dim("d", "d1", "d2", "d3", "d4")];

  it("covers every pair with far fewer scenarios than the full product", () => {
    const { scenarios } = generate(dimensions, [], { seed: 7 });
    expect(missing(scenarios, dimensions, [])).toEqual([]);
    // 3×3×2×4 = 72; the biggest pair is 3×4 = 12, so a good cover is close to that.
    expect(scenarios.length).toBeGreaterThanOrEqual(12);
    expect(scenarios.length).toBeLessThanOrEqual(18);
  });

  it("is deterministic for a seed", () => {
    expect(generate(dimensions, [], { seed: 3 }).scenarios).toEqual(generate(dimensions, [], { seed: 3 }).scenarios);
  });

  it("never emits a combination a constraint forbids, and reports the pairs it could not cover", () => {
    const constraints: Constraint[] = [
      { id: "no-a1-b1", why: "a1 cannot go with b1", dims: ["a", "b"], allows: (x) => !(x.a === "a1" && x.b === "b1") },
      { id: "c2-needs-d1", why: "c2 only with d1", dims: ["c", "d"], allows: (x) => x.c !== "c2" || x.d === undefined || x.d === "d1" },
    ];
    const { scenarios, impossible } = generate(dimensions, constraints, { seed: 11 });
    for (const s of scenarios) {
      expect(s.a === "a1" && s.b === "b1").toBe(false);
      if (s.c === "c2") expect(s.d).toBe("d1");
    }
    expect(missing(scenarios, dimensions, constraints)).toEqual([]);
    expect(impossible).toContain("a=a1&b=b1");
    expect(impossible).toContain("c=c2&d=d2");
  });

  it("drops a value no valid scenario can hold, instead of failing", () => {
    const constraints: Constraint[] = [
      // With c1 nothing but d1 goes, and with c2 nothing at all: c2 is unreachable.
      { id: "c2-never", why: "c2 is never possible", dims: ["c"], allows: (x) => x.c !== "c2" },
    ];
    const { scenarios, impossible } = generate(dimensions, constraints, { seed: 5 });
    expect(scenarios.every((s) => s.c === "c1")).toBe(true);
    expect(impossible.filter((t) => t.includes("c=c2")).length).toBeGreaterThan(0);
  });

  it("covers a chosen subset n-wise on top of all pairs", () => {
    const strengths = [{ dims: ["a", "b", "d"] }];
    const { scenarios } = generate(dimensions, [], { seed: 2, strengths });
    expect(missing(scenarios, dimensions, [], strengths)).toEqual([]);
    expect(new Set(scenarios.map((s) => `${s.a}${s.b}${s.d}`)).size).toBe(3 * 3 * 4);
  });

  it("completes a partial assignment only when the constraints allow it", () => {
    const constraints: Constraint[] = [{ id: "x", why: "", dims: ["a", "c"], allows: (x) => !(x.a === "a2" && x.c === "c1") }];
    expect(completable({ a: "a2" }, dimensions, constraints)?.c).toBe("c2");
    expect(completable({ a: "a2", c: "c1" }, dimensions, constraints)).toBeNull();
  });

  it("names a combination the same way whatever else was generated", () => {
    const s = { a: "a1", b: "b2", c: "c1", d: "d4" };
    expect(scenarioId(s, dimensions)).toBe(scenarioId({ d: "d4", c: "c1", b: "b2", a: "a1" }, dimensions));
    expect(scenarioId(s, dimensions)).toMatch(/^mx-[0-9a-f]{8}$/);
    expect(scenarioId(s, dimensions)).not.toBe(scenarioId({ ...s, d: "d3" }, dimensions));
  });
});
