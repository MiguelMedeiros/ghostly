/**
 * All-pairs (and, on a chosen subset, all-n-tuples) scenario generation.
 *
 * Every pair of values from two different dimensions shows up in at least one
 * scenario, unless no valid scenario can hold it (a constraint rules it out),
 * with as few scenarios as a greedy search finds. The search is AETG-style:
 * each scenario starts from a tuple nobody covers yet, fills the remaining
 * dimensions one at a time with the value that covers the most new tuples, and
 * the best of a few candidates is kept. Every choice is made with a seeded
 * generator, so a seed always yields the same matrix and a failing scenario can
 * be run again by its id.
 *
 * Nothing here knows about Ghostly: dimensions and constraints are data
 * (see dimensions.ts).
 */

export interface Dimension {
  id: string;
  label: string;
  values: readonly { id: string }[];
}

/** One value per dimension id. Partial while a scenario is being built. */
export type Assignment = Record<string, string>;

export interface Constraint {
  id: string;
  /** Why the combination cannot exist: shown when someone asks for it with --combo. */
  why: string;
  /** The dimensions it reads. */
  dims: readonly string[];
  /**
   * False when the assignment is impossible. Called on partial assignments too (as soon as one of
   * `dims` is set, the others possibly undefined), so it must answer true when it cannot tell yet:
   * that is what lets the search drop a dead end early instead of enumerating it.
   */
  allows: (assignment: Partial<Assignment>) => boolean;
}

export interface Strength {
  /** Every combination of values over these dimensions, not only pairs. */
  dims: readonly string[];
}

export interface GenerateOptions {
  seed?: number;
  /** Candidates tried per scenario: more is smaller matrices and slower generation. */
  candidates?: number;
  /** Subsets to cover fully (n-wise), on top of all pairs. */
  strengths?: readonly Strength[];
}

/** mulberry32: small, fast, and the same everywhere. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], next: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** The constraints a (partial) assignment already breaks. */
export function violations(assignment: Assignment, constraints: readonly Constraint[]): Constraint[] {
  return constraints.filter((c) => c.dims.some((d) => d in assignment) && !c.allows(assignment));
}

/**
 * Whether the partial assignment can be completed into a valid scenario.
 * Backtracking with the constraints checked as soon as they can be.
 */
export function completable(partial: Assignment, dimensions: readonly Dimension[], constraints: readonly Constraint[]): Assignment | null {
  if (violations(partial, constraints).length > 0) return null;
  const open = dimensions.filter((d) => !(d.id in partial));
  const walk = (index: number, current: Assignment): Assignment | null => {
    if (index === open.length) return current;
    const dimension = open[index];
    for (const value of dimension.values) {
      const next = { ...current, [dimension.id]: value.id };
      const relevant = constraints.filter((c) => c.dims.includes(dimension.id));
      if (violations(next, relevant).length > 0) continue;
      const done = walk(index + 1, next);
      if (done) return done;
    }
    return null;
  };
  return walk(0, partial);
}

const key = (dims: readonly string[], assignment: Assignment) => dims.map((d) => `${d}=${assignment[d]}`).join("&");

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of combinations(items.slice(i + 1), size - 1)) out.push([item, ...rest]);
  });
  return out;
}

function product(dimensions: readonly Dimension[]): Assignment[] {
  return dimensions.reduce<Assignment[]>(
    (acc, d) => acc.flatMap((a) => d.values.map((v) => ({ ...a, [d.id]: v.id }))),
    [{}],
  );
}

/** A group of dimensions whose value combinations must each appear somewhere. */
interface Group {
  dims: string[];
}

export interface Generated {
  scenarios: Assignment[];
  /** Tuples that no valid scenario can hold: ruled out by the constraints, never missed. */
  impossible: string[];
  /** How many tuples were required and covered (every one of them, or generation fails). */
  covered: number;
}

export function generate(dimensions: readonly Dimension[], constraints: readonly Constraint[], options: GenerateOptions = {}): Generated {
  const next = random(options.seed ?? 1);
  const candidates = options.candidates ?? 12;
  const byId = new Map(dimensions.map((d) => [d.id, d]));
  for (const c of constraints) for (const d of c.dims) if (!byId.has(d)) throw new Error(`constraint ${c.id} names unknown dimension ${d}`);

  const groups: Group[] = combinations(dimensions.map((d) => d.id), 2).map((dims) => ({ dims }));
  for (const strength of options.strengths ?? []) {
    for (const d of strength.dims) if (!byId.has(d)) throw new Error(`strength names unknown dimension ${d}`);
    groups.push({ dims: [...strength.dims] });
  }

  // Every tuple to cover, minus those no valid scenario can hold.
  const uncovered = new Map<string, { group: Group; tuple: Assignment }>();
  const impossible: string[] = [];
  for (const group of groups) {
    for (const tuple of product(group.dims.map((d) => byId.get(d)!))) {
      const k = key(group.dims, tuple);
      if (uncovered.has(k)) continue;
      if (completable(tuple, dimensions, constraints)) uncovered.set(k, { group, tuple });
      else impossible.push(k);
    }
  }
  const required = uncovered.size;

  const gain = (assignment: Assignment) => {
    let count = 0;
    for (const group of groups) {
      if (!group.dims.every((d) => d in assignment)) continue;
      if (uncovered.has(key(group.dims, assignment))) count++;
    }
    return count;
  };

  const scenarios: Assignment[] = [];
  while (uncovered.size > 0) {
    let best: Assignment | null = null;
    let bestGain = -1;
    const pending = [...uncovered.values()];
    for (let attempt = 0; attempt < candidates; attempt++) {
      const seed = pending[Math.floor(next() * pending.length)];
      let current: Assignment = { ...seed.tuple };
      const order = shuffle(dimensions.filter((d) => !(d.id in current)), next);
      for (const dimension of order) {
        let choice: Assignment | null = null;
        let choiceGain = -1;
        for (const value of shuffle([...dimension.values], next)) {
          const trial = { ...current, [dimension.id]: value.id };
          if (!completable(trial, dimensions, constraints)) continue;
          const g = gain(trial);
          if (g > choiceGain) {
            choice = trial;
            choiceGain = g;
          }
        }
        // The seed tuple is completable, so some value always is.
        current = choice!;
      }
      const g = gain(current);
      if (g > bestGain) {
        best = current;
        bestGain = g;
      }
    }
    if (!best || bestGain <= 0) throw new Error("pairwise generation made no progress");
    for (const group of groups) {
      uncovered.delete(key(group.dims, best));
    }
    // Keep dimension order stable in what is reported.
    scenarios.push(Object.fromEntries(dimensions.map((d) => [d.id, best![d.id]])));
  }
  return { scenarios, impossible, covered: required };
}

/** Checks a matrix: every coverable pair (and strength tuple) is in some scenario. Returns what is missing. */
export function missing(scenarios: readonly Assignment[], dimensions: readonly Dimension[], constraints: readonly Constraint[], strengths: readonly Strength[] = []): string[] {
  const byId = new Map(dimensions.map((d) => [d.id, d]));
  const groups = [...combinations(dimensions.map((d) => d.id), 2), ...strengths.map((s) => [...s.dims])];
  const seen = new Set<string>();
  for (const s of scenarios) for (const dims of groups) seen.add(key(dims, s));
  const out: string[] = [];
  for (const dims of groups) {
    for (const tuple of product(dims.map((d) => byId.get(d)!))) {
      const k = key(dims, tuple);
      if (!seen.has(k) && completable(tuple, dimensions, constraints)) out.push(k);
    }
  }
  return out;
}

/** A short id for a combination: the same combination always has the same id, whatever else was generated. */
export function scenarioId(assignment: Assignment, dimensions: readonly Dimension[]): string {
  const text = dimensions.map((d) => `${d.id}=${assignment[d.id]}`).join("&");
  // FNV-1a, 32 bits: ids only need to be distinct within a matrix of a few hundred.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `mx-${hash.toString(16).padStart(8, "0")}`;
}
