import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { chooseDhtOnly, expect, setDhtOnly, test, type Peer } from "../support/fixtures";

/**
 * A measurement, not a check: how long a paired chat takes to go live again after both sides leave
 * DHT-only, when the contact reloaded while the chat was DHT-only (the matrix's `delivery` step with
 * `dht`, docs/TESTING.md). Skipped unless `E2E_DHT_BACK_RUNS` says how many times to time it. The
 * engine prints one line per step when the page sets `__ghostlyLinkTrace` (packages/core/src/linkTrace.ts);
 * every run is appended to `test-results/dht-back-timing.jsonl` (or `E2E_DHT_BACK_OUT`) and the distribution printed.
 */
const RUNS = Number(process.env.E2E_DHT_BACK_RUNS ?? 0);

interface Step { t: number; me: string; step: string; who?: string; [key: string]: unknown }

async function traced(peer: Peer, steps: Step[]): Promise<void> {
  await peer.context.addInitScript(() => { (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace = true; });
  await peer.page.evaluate(() => { (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace = true; });
  const listen = (page: Peer["page"]) => page.on("console", message => {
    const text = message.text();
    if (!text.startsWith("[ghostly:link] ")) return;
    try { steps.push({ ...JSON.parse(text.slice(15)), who: peer.name }); } catch { /* not ours */ }
  });
  listen(peer.page);
  peer.context.on("page", listen);
}

const chatPane = (peer: Peer) => peer.page.locator(".chat-wallpaper");
const say = async (peer: Peer, text: string) => {
  await peer.page.getByPlaceholder("Message…").fill(text);
  await peer.page.getByPlaceholder("Message…").press("Enter");
};
const connected = (peer: Peer, timeout: number) =>
  expect(peer.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected · WebRTC/, { timeout });

const dhtOnly = (peer: Peer, on: boolean): Promise<void> => setDhtOnly(peer.page, on);

const percentile = (values: number[], p: number) => values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : NaN;

test.describe.configure({ mode: "serial" });
test.skip(!RUNS, "a measurement: set E2E_DHT_BACK_RUNS");

test("time leaving DHT-only after the contact reloaded, step by step", { tag: ["@feature:invite.delivery-mode", "@feature:transport.webrtc"] }, async ({ peer }) => {
  test.setTimeout(RUNS * 6 * 60_000);
  const file = process.env.E2E_DHT_BACK_OUT ?? join(process.cwd(), "test-results", "dht-back-timing.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  const totals: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    const [alice, bob] = await Promise.all([peer(`alice${run}`), peer(`bob${run}`)]);
    const steps: Step[] = [];
    await Promise.all([traced(alice, steps), traced(bob, steps)]);

    await alice.page.getByTitle("New Chat").click();
    await chooseDhtOnly(alice.page);
    await alice.page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { (window as unknown as { qaInvite: string }).qaInvite = value; } } });
    });
    await alice.page.getByTestId("invite-card").getByRole("button", { name: "Copy invite" }).click();
    const invite = await alice.page.evaluate(() => (window as unknown as { qaInvite: string }).qaInvite);
    expect(invite).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p/);
    await bob.page.getByRole("button", { name: "Join chat" }).first().click();
    await bob.page.evaluate(text => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: async () => text } });
    }, invite);
    await bob.page.getByRole("button", { name: "Paste from clipboard" }).click();
    for (const p of [alice, bob]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled({ timeout: 90_000 });

    await say(bob, "boo");
    await expect(chatPane(alice).getByText("boo")).toBeVisible();

    // Bob goes away (his page closes) and comes back to the chat while it is DHT-only.
    const url = bob.page.url();
    await bob.page.close();
    await say(alice, "waiting in the DHT mailbox");
    bob.page = await bob.context.newPage();
    await bob.page.goto(url);
    await expect(chatPane(bob).getByText("waiting in the DHT mailbox")).toBeVisible({ timeout: 90_000 });
    await expect(chatPane(alice).getByText("Received by peer").first()).toBeVisible({ timeout: 90_000 });

    const t0 = Date.now();
    await dhtOnly(bob, false);
    const bobOff = Date.now() - t0;
    await dhtOnly(alice, false);
    const aliceOff = Date.now() - t0;
    let live: number | undefined;
    try {
      await Promise.all([connected(alice, 240_000), connected(bob, 240_000)]);
      live = Date.now() - t0;
    } catch { /* recorded as not live */ }
    const relative = steps.filter(s => s.t >= t0 - 1_000).map(s => ({ ...s, at: s.t - t0 }));
    const row = { run, bobOff, aliceOff, live, steps: relative.map(({ t: _t, ...rest }) => rest) };
    appendFileSync(file, JSON.stringify(row) + "\n");
    console.log(`run ${run}: live after ${live ?? "never (240 s)"} ms`);
    for (const s of relative) console.log(`  +${String(s.at).padStart(6)} ${s.who?.padEnd(8)} ${s.step} ${JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => !["t", "me", "step", "who", "at"].includes(k))))}`);
    totals.push(live ?? Infinity);
    await Promise.all([alice.context.close(), bob.context.close()]);
  }
  const sorted = [...totals].sort((x, y) => x - y);
  console.log(`live after (ms): p50 ${percentile(sorted, 0.5)} · p90 ${percentile(sorted, 0.9)} · max ${sorted.at(-1)} · all ${JSON.stringify(totals)}`);
});
