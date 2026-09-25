import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test, type Peer } from "../support/fixtures";
import { copyInvite, pasteInvite } from "../support/clipboard";
import { LocalRelay } from "../support/relay";

/**
 * How long a first pairing takes, step by step, from the joiner pasting the invite to both chats live:
 * the joiner's packet out, the inviter seeing it, the offer, the answer, the connection, the session.
 * The engine prints one line per step when the page sets `__ghostlyLinkTrace` (packages/core/src/linkTrace.ts).
 *
 * As a check (the default): a few pairings on the test's own relay at the desktop app's pace
 * (`ghostly-test-pace`), each one live within `E2E_PAIR_BOUND_MS` on the first attempt, the stages in
 * order. It fails when pairing gets slow again.
 *
 * As a measurement: `E2E_PAIR_RUNS=n` times that many pairings and prints the distribution; every run is
 * appended to `test-results/pairing-timing.jsonl` (or `E2E_PAIR_OUT`). `E2E_PAIR_BRIDGES=<url a>,<url b>`
 * sends each peer's relay requests to a relay-shaped front on the desktop app's own Pkarr code (the Rust
 * client, the real DHT and relays): a Desktop↔Desktop pairing, at Desktop pace, driven from here.
 * `E2E_REAL_RELAYS=1` uses the public relays at the web's pace instead.
 */
const RUNS = Number(process.env.E2E_PAIR_RUNS ?? 0);
const CHECK_RUNS = 3;
const BOUND_MS = Number(process.env.E2E_PAIR_BOUND_MS ?? 8_000);
const BRIDGES = process.env.E2E_PAIR_BRIDGES?.split(",").map(s => s.trim()).filter(Boolean);
const REAL = process.env.E2E_REAL_RELAYS === "1";
/** How long the apps have been open when the chat is made (the engine warms its spare invite at start). */
const APP_OPEN_MS = Number(process.env.E2E_PAIR_APP_OPEN_MS ?? 8_000);
/** How old the invite is when it is pasted: a copy and a paste on one machine take a few seconds. */
const INVITE_AGE_MS = Number(process.env.E2E_PAIR_INVITE_AGE_MS ?? 3_000);
/** `desktop` (the DHT client's poll intervals) or `web` (the relays'). */
const PACE = process.env.E2E_PAIR_PACE ?? (REAL ? "web" : "desktop");

interface Step { t: number; me: string; step: string; who?: string; [key: string]: unknown }

async function traced(peer: Peer, steps: Step[]): Promise<void> {
  await peer.context.addInitScript(() => { (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace = true; });
  const listen = (page: Peer["page"]) => page.on("console", message => {
    const text = message.text();
    if (!text.startsWith("[ghostly:link] ")) return;
    try { steps.push({ ...JSON.parse(text.slice(15)), who: peer.name }); } catch { /* not ours */ }
  });
  listen(peer.page);
  peer.context.on("page", listen);
}

/** The page's peer at the wanted pace, and traced from its start: both are read when the peer is made, hence the reload. */
async function prepare(peer: Peer, steps: Step[], bridge?: string): Promise<void> {
  if (bridge) await peer.context.route(LocalRelay.pattern, async route => {
    const url = new URL(route.request().url());
    try {
      const response = await route.fetch({ url: `${bridge}${url.pathname}` });
      await route.fulfill({ response });
    } catch { await route.abort().catch(() => {}); }
  });
  await traced(peer, steps);
  await peer.page.evaluate(pace => { localStorage.setItem("ghostly-test-pace", pace); }, PACE);
  await peer.page.reload();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

const live = (peer: Peer, timeout: number) =>
  expect(peer.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected · WebRTC/, { timeout });

/** Milliseconds from `t0` to the first step of `who` matching. */
const at = (steps: Step[], t0: number, who: string, match: (s: Step) => boolean) => {
  const hit = steps.find(s => s.who === who && s.t >= t0 - 50 && match(s));
  return hit ? hit.t - t0 : undefined;
};
const percentile = (values: number[], p: number) => values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : NaN;

interface Row { run: number; joinerPublished?: number; inviterSawJoiner?: number; joinerSawInviter?: number; offerSent?: number; offerSeen?: number; answerSent?: number; answerSeen?: number; open?: number; ready?: number; uiLive?: number; attempts: number; dialer: string; stagesOk: boolean }

async function pairOnce(run: number, peer: (name: string, options?: { realRelays?: boolean }) => Promise<Peer>): Promise<{ row: Row; steps: Step[] }> {
  const [inviter, joiner] = await Promise.all([peer(`inviter${run}`, { realRelays: REAL || !!BRIDGES }), peer(`joiner${run}`, { realRelays: REAL || !!BRIDGES })]);
  const steps: Step[] = [];
  await Promise.all([prepare(inviter, steps, BRIDGES?.[0]), prepare(joiner, steps, BRIDGES?.[1] ?? BRIDGES?.[0])]);
  // The apps have been open a while, as they would be: the inviter's spare invite is warmed and settled.
  await inviter.page.waitForTimeout(APP_OPEN_MS);

  await inviter.page.getByTitle("New Chat").click();
  const invite = await copyInvite(inviter.page);
  expect(invite).toMatch(/^pair1\//);
  // The invite was made a moment ago, as when someone copies it and sends it over (`E2E_PAIR_INVITE_AGE_MS`).
  await inviter.page.waitForTimeout(INVITE_AGE_MS);
  await joiner.page.getByRole("button", { name: "Join chat", exact: true }).first().click();

  const t0 = Date.now();
  await pasteInvite(joiner.page, invite);
  let uiLive: number | undefined;
  try {
    await Promise.all([live(inviter, 120_000), live(joiner, 120_000)]);
    uiLive = Date.now() - t0;
  } catch { /* recorded as not live */ }

  const I = inviter.name, J = joiner.name;
  const progress = (who: string) => steps.filter(s => s.who === who && s.step === "progress" && s.t >= t0 - 50).map(s => String(s.stage));
  const knockerIsInviter = progress(I).includes("knocking");
  const [K, A] = knockerIsInviter ? [I, J] : [J, I];
  const row: Row = {
    run,
    joinerPublished: at(steps, t0, J, s => s.step === "publish" && !s.error),
    joinerSawInviter: at(steps, t0, J, s => s.step === "poll" && s.online === true),
    inviterSawJoiner: at(steps, t0, I, s => s.step === "poll" && s.online === true),
    offerSent: at(steps, t0, K, s => s.step === "progress" && s.stage === "knocking"),
    offerSeen: at(steps, t0, A, s => s.step === "progress" && s.stage === "answering"),
    answerSent: at(steps, t0, A, s => s.step === "progress" && s.stage === "connecting"),
    answerSeen: at(steps, t0, K, s => s.step === "progress" && s.stage === "connecting"),
    open: Math.max(at(steps, t0, I, s => s.step === "datalink" && s.state === "open") ?? Infinity, at(steps, t0, J, s => s.step === "datalink" && s.state === "open") ?? Infinity),
    ready: Math.max(at(steps, t0, I, s => s.step === "paired-ready") ?? Infinity, at(steps, t0, J, s => s.step === "paired-ready") ?? Infinity),
    uiLive,
    attempts: Math.max(...[I, J].map(who => steps.filter(s => s.who === who && s.step === "progress" && s.t >= t0 - 50).reduce((m, s) => Math.max(m, Number(s.attempt) || 0), 0))),
    dialer: knockerIsInviter ? "inviter" : "joiner",
    stagesOk: JSON.stringify(progress(K).filter(s => s !== "waiting" && s !== "resolving")) === JSON.stringify(["knocking", "connecting", "live"])
      && JSON.stringify(progress(A).filter(s => s !== "waiting" && s !== "resolving")) === JSON.stringify(["answering", "connecting", "live"]),
  };
  // Requests still in flight through the bridge must not fail the run as the contexts go.
  for (const p of [inviter, joiner]) await p.context.unrouteAll({ behavior: "ignoreErrors" });
  await Promise.all([inviter.context.close(), joiner.context.close()]);
  return { row, steps: steps.filter(s => s.t >= t0 - 5_000).map(s => ({ ...s, t: s.t - t0 })) };
}

test.describe.configure({ mode: "serial" });

test("a first pairing is live in seconds, step by step", { tag: ["@feature:chat.paired.pair-timing", "@feature:chat.paired.progress", "@feature:chat.paired.pair"] }, async ({ peer }) => {
  const runs = RUNS || CHECK_RUNS;
  test.setTimeout(runs * 3 * 60_000);
  const file = process.env.E2E_PAIR_OUT ?? join(process.cwd(), "test-results", "pairing-timing.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  const rows: Row[] = [];
  for (let run = 0; run < runs; run++) {
    const { row, steps } = await pairOnce(run, peer);
    rows.push(row);
    appendFileSync(file, JSON.stringify({ ...row, pace: PACE, bridged: !!BRIDGES, real: REAL, inviteAge: INVITE_AGE_MS, steps }) + "\n");
    console.log(`  run ${run}: ${JSON.stringify(row)}`);
    if (RUNS) for (const s of steps) console.log(`    +${String(s.t).padStart(6)} ${s.who?.padEnd(9)} ${s.step} ${JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => !["t", "me", "step", "who"].includes(k))))}`);
  }
  const keys = ["joinerPublished", "joinerSawInviter", "inviterSawJoiner", "offerSent", "offerSeen", "answerSent", "answerSeen", "open", "ready", "uiLive"] as const;
  console.log(`\n  ${runs} pairings, ${PACE} pace, ${BRIDGES ? "desktop's Pkarr client (bridged)" : REAL ? "public relays" : "test relay"}, invite ${INVITE_AGE_MS / 1000} s old, ms from the join: median / p90 / max`);
  for (const key of keys) {
    const values = rows.map(r => r[key]).filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
    console.log(`  ${key.padEnd(16)} ${String(percentile(values, 0.5)).padStart(7)} ${String(percentile(values, 0.9)).padStart(7)} ${String(values[values.length - 1] ?? NaN).padStart(7)}  (n=${values.length})`);
  }
  if (RUNS) return;
  // The check: every pairing live within the bound, first attempt, stages in order.
  for (const row of rows) {
    expect(row.ready, `run ${row.run} ready (${JSON.stringify(row)})`).toBeLessThanOrEqual(BOUND_MS);
    expect(row.attempts, `run ${row.run} attempts`).toBe(1);
    expect(row.stagesOk, `run ${row.run} stages`).toBe(true);
  }
});
