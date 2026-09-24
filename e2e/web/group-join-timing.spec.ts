import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type Peer } from "../support/fixtures";

/**
 * A measurement, not a check: how long a join through a group's link takes, step by step, with the
 * admin's app open. Skipped unless `E2E_JOIN_RUNS` says how many joins to time; `E2E_REAL_RELAYS=1`
 * sends both peers to the public Pkarr relays instead of the test's own. The engine prints one line
 * per step when the page sets `__ghostlyJoinTrace` (`packages/browser/src/engine/joinTrace.ts`);
 * every run is appended to `test-results/group-join-timing.jsonl` (or `E2E_JOIN_OUT`) and the distribution printed.
 */
const RUNS = Number(process.env.E2E_JOIN_RUNS ?? 0);
const REAL = process.env.E2E_REAL_RELAYS === "1";

interface Step { t: number; g: string; step: string; role?: string; [key: string]: unknown }

async function traced(peer: Peer, steps: Step[]): Promise<void> {
  peer.page.on("console", message => {
    const text = message.text();
    if (!text.startsWith("[ghostly:join] ")) return;
    try { steps.push({ ...JSON.parse(text.slice(15)), who: peer.name }); } catch { /* not ours */ }
  });
  await peer.page.evaluate(() => { (globalThis as { __ghostlyJoinTrace?: boolean }).__ghostlyJoinTrace = true; });
}

/** Milliseconds from the join to the first time `who` logged `step` (with `role`, when given). */
function at(steps: Step[], t0: number, who: string, step: string, role?: string): number | undefined {
  const hit = steps.find(s => s.who === who && s.step === step && (!role || s.role === role));
  return hit ? hit.t - t0 : undefined;
}

const percentile = (values: number[], p: number) => values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : NaN;

test.describe.configure({ mode: "serial" });
test.skip(!RUNS, "a measurement: set E2E_JOIN_RUNS");

test("time a join through a group's link, step by step", { tag: ["@feature:groups.link.join", "@gated"] }, async ({ peer }) => {
  test.setTimeout(RUNS * 4 * 60_000);
  const rows: Record<string, number | undefined>[] = [];
  const file = process.env.E2E_JOIN_OUT ?? join(process.cwd(), "test-results", "group-join-timing.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  for (let run = 0; run < RUNS; run++) {
    const [alice, bob] = await Promise.all([peer(`alice${run}`, { realRelays: REAL }), peer(`bob${run}`, { realRelays: REAL })]);
    const steps: Step[] = [];
    await Promise.all([traced(alice, steps), traced(bob, steps)]);
    await alice.page.getByTestId("sidebar-new-more").click();
    await alice.page.getByTestId("new-group").click();
    await alice.page.getByTestId("new-group-name").fill(`timing ${run}`);
    // A private group (group-mesh/1): the steps timed here are its link join and edge.
    await alice.page.getByTestId("new-group-kind-mesh").click();
    await alice.page.getByTestId("new-group-create").click();
    const url = await alice.page.getByTestId("group-share-dialog").getByTestId("group-link-url").inputValue();
    await alice.page.getByTestId("group-share-dialog").getByTestId("group-share-done").click();
    // The admin's app has been open a while, as it would be: its link is being watched already.
    await alice.page.waitForTimeout(6_000);

    const clicked = Date.now();
    await bob.page.goto(url);
    await expect(bob.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 180_000 });
    const active = Date.now() - clicked;
    await expect(bob.page.getByTestId("group-members")).toContainText("1 of 1 reachable", { timeout: 180_000 });
    const reachable = Date.now() - clicked;

    const t0 = steps.find(s => s.who === bob.name && s.step === "join.start")?.t ?? clicked;
    const row = {
      run, real: REAL ? 1 : 0,
      knockPublished: at(steps, t0, bob.name, "knock.published"),
      knockSeen: at(steps, t0, alice.name, "knock.seen"),
      hostPresence: at(steps, t0, alice.name, "link.presence", "host"),
      guestPresence: at(steps, t0, bob.name, "link.presence", "guest"),
      offering: Math.min(at(steps, t0, alice.name, "link.offering", "host") ?? Infinity, at(steps, t0, bob.name, "link.offering", "guest") ?? Infinity),
      answering: Math.min(at(steps, t0, alice.name, "link.answering", "host") ?? Infinity, at(steps, t0, bob.name, "link.answering", "guest") ?? Infinity),
      entryOpen: at(steps, t0, bob.name, "link.open", "guest"),
      inviteSent: at(steps, t0, alice.name, "invite.sent"),
      welcomeReceived: at(steps, t0, bob.name, "welcome.received"),
      uiActive: active - (t0 - clicked),
      edgeOffering: Math.min(at(steps, t0, alice.name, "link.offering", "edge") ?? Infinity, at(steps, t0, bob.name, "link.offering", "edge") ?? Infinity),
      edgeOpen: at(steps, t0, bob.name, "link.ready", "edge"),
      uiReachable: reachable - (t0 - clicked),
    };
    rows.push(row);
    appendFileSync(file, JSON.stringify({ ...row, steps: steps.map(s => ({ ...s, t: s.t - t0 })) }) + "\n");
    console.log(`  run ${run}: ${JSON.stringify(row)}`);
    await Promise.all([alice.context.close(), bob.context.close()]);
  }
  const keys = Object.keys(rows[0]).filter(k => k !== "run" && k !== "real");
  console.log(`\n  ${RUNS} joins (${REAL ? "public relays" : "test relay"}), ms from the join: median / p90 / max`);
  for (const key of keys) {
    const values = rows.map(r => r[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
    console.log(`  ${key.padEnd(16)} ${String(percentile(values, 0.5)).padStart(7)} ${String(percentile(values, 0.9)).padStart(7)} ${String(values[values.length - 1] ?? NaN).padStart(7)}  (n=${values.length})`);
  }
});
