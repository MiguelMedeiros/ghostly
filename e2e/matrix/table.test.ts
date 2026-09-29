import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSTRAINTS, DIMENSIONS, STRENGTHS } from "./dimensions";
import { BEGIN, END, matrix, renderTable } from "./matrix";
import { missing, violations } from "./pairwise";

const spec = join(import.meta.dirname, "matrix.spec.ts");

describe("the matrix matrix.spec.ts carries", () => {
  const scenarios = matrix();

  it("covers every pair of values, and every client × transport × delivery, with no impossible scenario", () => {
    const assignments = scenarios.map((s) => s.combination as unknown as Record<string, string>);
    expect(missing(assignments, DIMENSIONS, CONSTRAINTS, STRENGTHS)).toEqual([]);
    for (const a of assignments) expect(violations(a, CONSTRAINTS).map((c) => c.id)).toEqual([]);
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
  });

  it("is the generated one (MATRIX_WRITE=1 rewrites it)", () => {
    const text = readFileSync(spec, "utf8");
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    expect(start, `${spec} has lost its table markers`).toBeGreaterThanOrEqual(0);
    const table = renderTable(scenarios);
    if (process.env.MATRIX_WRITE === "1") writeFileSync(spec, text.slice(0, start) + table + text.slice(end + END.length));
    else expect(text.slice(start, end + END.length), "the matrix changed: run npm run e2e:matrix:table").toBe(table);
  });
});
