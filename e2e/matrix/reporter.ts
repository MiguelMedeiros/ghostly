import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { DIMENSIONS, SEED } from "./dimensions";

/**
 * The matrix as a table: one row per scenario, one column per dimension, and
 * how it went. Written as JSON (for the docs and for merging shards) and as
 * markdown (the job summary, and docs/TESTING.md through scripts/matrix-docs.mjs).
 *
 * The HTML report shows the same thing from the other side: every scenario is
 * a test titled with its id and combination, tagged `@<dimension>:<value>`, so
 * filtering by a tag there lists every scenario with that value and its result.
 */

export interface MatrixRow {
  id: string;
  combination: Record<string, string>;
  status: "passed" | "failed" | "skipped" | "timedOut" | "interrupted";
  /** Why it was skipped, or the first line of the error. */
  note: string;
  durationMs: number;
  features: string[];
  /** Blocks that did not run, with the reason: infrastructure not up, or not written yet. */
  skippedBlocks: string[];
  failedStep?: string;
}

const annotation = (test: TestCase, type: string) => test.annotations.find((a) => a.type === type)?.description;

export function markdown(rows: readonly MatrixRow[], meta: { seed?: string; wallMs?: number } = {}): string {
  const count = (s: MatrixRow["status"]) => rows.filter((r) => r.status === s).length;
  const partial = rows.filter((r) => r.status === "passed" && r.skippedBlocks.length).length;
  const failed = rows.filter((r) => r.status === "failed" || r.status === "timedOut");
  const lines = [
    `**${rows.length} scenarios**: ${count("passed")} passed (${partial} of them with blocks skipped), ${failed.length} failed, ${count("skipped")} skipped` +
      (meta.wallMs ? ` · ${Math.round(meta.wallMs / 60_000)} min` : "") + (meta.seed ? ` · seed ${meta.seed}` : ""),
    "",
    `| id | ${DIMENSIONS.map((d) => d.label).join(" | ")} | result |`,
    `|---|${DIMENSIONS.map(() => "---").join("|")}|---|`,
  ];
  const icon = (r: MatrixRow) => (r.status === "passed" ? "✅" : r.status === "skipped" ? "⏭️" : "❌");
  const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const note = row.status === "passed"
      ? (row.skippedBlocks.length ? ` partial — ${cell(row.skippedBlocks.join("; ")).slice(0, 140)}` : "")
      : ` ${cell(row.failedStep ? `${row.failedStep}: ${row.note}` : row.note).slice(0, 140)}`;
    lines.push(`| \`${row.id}\` | ${DIMENSIONS.map((d) => row.combination[d.id] ?? "").join(" | ")} | ${icon(row)}${note} |`);
  }
  if (failed.length) {
    lines.push("", "Reproduce one: `npm run e2e:matrix -- --only <id>`.");
  }
  return lines.join("\n");
}

export default class MatrixReporter implements Reporter {
  private readonly rows = new Map<string, MatrixRow>();
  private outputDir: string;
  private started = Date.now();

  /** `outputDir` is relative to the config file, like the config's other paths. */
  constructor(private readonly options: { outputDir?: string } = {}) {
    this.outputDir = resolve(options.outputDir ?? "test-results/matrix-summary");
  }

  onBegin(config: FullConfig): void {
    this.started = Date.now();
    if (config.configFile) this.outputDir = resolve(dirname(config.configFile), this.options.outputDir ?? "../test-results/matrix-summary");
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const id = annotation(test, "matrix-id");
    if (!id) return;
    const combination = JSON.parse(annotation(test, "matrix-combination") ?? "{}") as Record<string, string>;
    const failedStep = result.steps.flatMap(function walk(step): string[] {
      return step.error ? [step.title, ...step.steps.flatMap(walk)] : [];
    }).at(-1);
    // Annotations added while the test runs are on the result (newer Playwright) or the test (older).
    const all = [...test.annotations, ...result.annotations];
    const noted = (type: string) => [...new Set(all.filter((a) => a.type === type).map((a) => a.description ?? ""))];
    const skip = all.find((a) => a.type === "skip")?.description ?? "";
    this.rows.set(id, {
      id,
      combination,
      status: result.status,
      note: result.status === "skipped" ? skip : (result.error?.message ?? "").split("\n").find((l) => l.trim()) ?? "",
      durationMs: result.duration,
      features: noted("feature"),
      skippedBlocks: noted("skipped-block"),
      ...(result.status === "passed" || result.status === "skipped" || !failedStep ? {} : { failedStep }),
    });
  }

  onEnd(_result: FullResult): void {
    if (this.rows.size === 0) return;
    const rows = [...this.rows.values()];
    const meta = { seed: String(SEED), wallMs: Date.now() - this.started };
    mkdirSync(this.outputDir, { recursive: true });
    writeFileSync(join(this.outputDir, "results.json"), JSON.stringify({ ...meta, rows }, null, 2));
    writeFileSync(join(this.outputDir, "summary.md"), `${markdown(rows, meta)}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Combination matrix\n\n${markdown(rows, meta)}\n`, { flag: "a" });
  }

  printsToStdio(): boolean {
    return false;
  }
}
