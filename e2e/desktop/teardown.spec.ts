import { endAll, expect, test, type Processes } from "../support/desktop";

/**
 * How a Desktop test ends what its app started (`endAll`). A process still there 5 s after SIGKILL was seen in the
 * loop's teardown (groups.spec.ts passed, then failed on it): such a process is in uninterruptible sleep (state D, a
 * WebKitGTK/GPU or disk wait) and ends once that wait does, so it is waited for longer, and the error says what it was.
 */

/** A fake process table: each PID's name, state and wait channel, and when SIGKILL ends it (ms after it, or never). */
function table(rows: Record<number, { name: string; state: string; wchan: string; endsAfterKillMs?: number }>) {
  const ended = new Set<number>();
  const procs: Processes = {
    stat: (pid) => {
      const row = rows[pid];
      if (!row || ended.has(pid)) return null;
      const fields = Array<string>(20).fill("0");
      fields[0] = row.state;
      fields[19] = "1";
      return fields;
    },
    name: (pid) => rows[pid]?.name ?? "",
    wchan: (pid) => rows[pid]?.wchan ?? "",
    kill: (pid, signal) => {
      const after = rows[pid]?.endsAfterKillMs;
      if (signal === "SIGKILL" && after !== undefined) setTimeout(() => ended.add(pid), after);
    },
  };
  return procs;
}

const WAITS = { own: 10, signal: 10, uninterruptible: 2_000 };

test("a process in uninterruptible sleep after SIGKILL is waited for until it ends", { tag: ["@feature:desktop.boot"] }, async () => {
  const procs = table({ 41: { name: "WebKitWebProcess", state: "D", wchan: "folio_wait_bit_common", endsAfterKillMs: 300 } });
  await endAll([{ pid: 41, started: "1" }], procs, WAITS);
});

test("a process still in uninterruptible sleep is named with its state and wait channel", { tag: ["@feature:desktop.boot"] }, async () => {
  const procs = table({ 41: { name: "WebKitWebProcess", state: "D", wchan: "folio_wait_bit_common" } });
  const started = Date.now();
  await expect(endAll([{ pid: 41, started: "1" }], procs, WAITS))
    .rejects.toThrow("The Desktop app's processes 41 (WebKitWebProcess, state D in folio_wait_bit_common) outlived SIGKILL");
  expect(Date.now() - started).toBeGreaterThanOrEqual(WAITS.uninterruptible);
});

test("a leftover that is not in uninterruptible sleep fails without the longer wait", { tag: ["@feature:desktop.boot"] }, async () => {
  const procs = table({ 42: { name: "ghostly", state: "S", wchan: "do_epoll_wait" } });
  const started = Date.now();
  await expect(endAll([{ pid: 42, started: "1" }], procs, WAITS))
    .rejects.toThrow("The Desktop app's processes 42 (ghostly, state S in do_epoll_wait) outlived SIGKILL");
  expect(Date.now() - started).toBeLessThan(WAITS.uninterruptible);
});
