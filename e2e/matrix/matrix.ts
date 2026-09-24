import { CONSTRAINTS, DIMENSIONS, SEED, STRENGTHS, valueOf, type Combination } from "./dimensions";
import { completable, generate, scenarioId, violations, type Assignment } from "./pairwise";
import { tagsFor } from "./plan";

/**
 * The matrix: the generated scenarios, and the table of them that matrix.spec.ts carries.
 *
 * The table is written into the spec (`npm run e2e:matrix:table`) rather than computed when it loads,
 * so the scenarios are reviewable in a diff and their tags are string literals the test map
 * (scripts/test-map.mjs) can read without running anything. table.test.ts fails when it is stale.
 */
export interface Scenario {
  id: string;
  combination: Combination;
}

export const toScenario = (assignment: Assignment): Scenario => {
  const combination = Object.fromEntries(DIMENSIONS.map((d) => [d.id, assignment[d.id]])) as Combination;
  return { id: scenarioId(combination, DIMENSIONS), combination };
};

export function matrix(seed = SEED): Scenario[] {
  return generate(DIMENSIONS, CONSTRAINTS, { seed, strengths: STRENGTHS }).scenarios.map(toScenario);
}

/** `client=web-web,delivery=dht,…` (or the values alone, in dimension order): one combination, the rest filled in. */
export function parseCombination(text: string): Scenario {
  const partial: Assignment = {};
  const parts = text.split(/[,\s]+/).filter(Boolean);
  parts.forEach((part, index) => {
    const [dimension, value] = part.includes("=") ? part.split("=") : [DIMENSIONS[index]?.id, part];
    if (!dimension) throw new Error(`too many values in ${text}`);
    valueOf(dimension as never, value);
    partial[dimension] = value;
  });
  const broken = violations(partial, CONSTRAINTS);
  if (broken.length) throw new Error(`impossible combination: ${broken.map((c) => c.why).join("; ")}`);
  const complete = completable(partial, DIMENSIONS, CONSTRAINTS);
  if (!complete) throw new Error(`no scenario can hold ${text}`);
  return toScenario(complete);
}

export const BEGIN = "// matrix:table:begin — written by `npm run e2e:matrix:table`; do not edit by hand";
export const END = "// matrix:table:end";

export function renderTable(scenarios: readonly Scenario[]): string {
  const rows = scenarios.map(({ id, combination }) => {
    const values = DIMENSIONS.map((d) => combination[d.id]).join(" ");
    const tag = tagsFor(combination).map((t) => JSON.stringify(t)).join(", ");
    return `  { id: "${id}", values: "${values}", tag: [${tag}] },`;
  });
  return [BEGIN, `// ${scenarios.length} scenarios, seed ${SEED}: every pair of values, and every ${STRENGTHS.map((s) => s.dims.join(" × ")).join(", ")} combination.`, "const TABLE: readonly { id: string; values: string; tag: string[] }[] = [", ...rows, "];", END].join("\n");
}
