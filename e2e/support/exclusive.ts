import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Work on a shared node pair, one test at a time, whatever the worker or the runner (the web suite, the scenario
 * matrix). The Lightning suites of e2e/infra have one pair of nodes each: two tests paying over the same channel at
 * once would each see the other's payments in the balances. A lock directory per name, held by a live process.
 * Names in use: "lnd", "cln", "nwc" (the node pairs), "breez", "bark-funder", "regtest-chain".
 * Take several in one order (lnd before nwc), so two tests never wait on each other.
 */
export async function exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), "ghostly-e2e-locks", name);
  mkdirSync(join(dir, ".."), { recursive: true });
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      break;
    } catch {
      let holder = NaN;
      try { holder = Number(readFileSync(join(dir, "pid"), "utf8")); } catch { /* just made: its pid comes next */ }
      let alive = true;
      if (Number.isInteger(holder)) try { process.kill(holder, 0); } catch { alive = false; }
      if (!alive) rmSync(dir, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
