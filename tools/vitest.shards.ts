import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/**
 * The files of shard `index` of `count`: heaviest first to the lightest shard (the one with fewer files on a tie, so
 * files with no measurable time spread out too), by the seconds CI took per file (repository paths; a file with no
 * time counts as a typical one, the median), ties by path and by shard number, and the shards then ordered heaviest
 * first. Every shard computes the same split from the same files, whatever their order, so each file runs in exactly
 * one shard.
 */
export function shardByTime(files: string[], seconds: Record<string, number>, index: number, count: number): string[] {
  const known = Object.values(seconds).sort((a, b) => a - b);
  const typical = known.length ? known[Math.floor(known.length / 2)] : 1;
  const weight = (file: string) => seconds[file] ?? typical;
  const shards = Array.from({ length: count }, (_, n) => ({ n, load: 0, files: [] as string[] }));
  const order = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
  const lighter = (s: (typeof shards)[number], best: (typeof shards)[number]) => s.load < best.load || (s.load === best.load && s.files.length < best.files.length);
  for (const file of order) {
    const lightest = shards.reduce((best, s) => (lighter(s, best) ? s : best));
    lightest.load += weight(file);
    lightest.files.push(file);
  }
  shards.sort((a, b) => b.load - a.load || b.files.length - a.files.length || a.n - b.n);
  return shards[index - 1].files;
}

/**
 * `vitest --shard <i>/<n>` cut by time. Vitest's own sequencer sorts the files by a hash of their path and gives each
 * shard as many files: the CLI's few slow files (one to three minutes each, among many of a second or two)
 * fell mostly in one half, which took twice the other's time (CI's draft tier runs the CLI in two halves,
 * tools/scripts/affected/select.mjs UNIT_HALVED). The times are the packages shards' record
 * (tools/scripts/test-durations.json): a stale record only unbalances the halves, it never drops a file. Only
 * `--shard` reads this; the order a run takes its files in is Vitest's own.
 */
export class TimedShards extends BaseSequencer {
  override async shard(specs: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const seconds: Record<string, number> = JSON.parse(readFileSync(new URL("./scripts/test-durations.json", import.meta.url), "utf8"));
    const path = (spec: TestSpecification) => relative(REPO, spec.moduleId).replaceAll("\\", "/");
    const mine = new Set(shardByTime(specs.map(path), seconds, index, count));
    return specs.filter((spec) => mine.has(path(spec)));
  }
}
