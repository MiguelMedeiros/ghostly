import { chat, expect, say, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * A relay that answers, but slowly, must not slow a pairing down. Here every request to `pkarr.pubky.org` waits
 * `E2E_SLOW_RELAY_MS` (8 s by default) before the test's relay answers it; `pkarr.pubky.app` answers at once. A read
 * asks the next relay too once the first has not answered within the hedge delay (`HEDGE_MS` in
 * packages/core/src/relay.ts), takes the first good answer, and starts later reads with the faster relay: the two
 * people are live in about the time a pairing takes with both relays fast.
 *
 * `E2E_SLOW_RELAY_MS=0` measures the same pairing with both relays fast. Each run prints its time.
 */
const SLOW_MS = Number(process.env.E2E_SLOW_RELAY_MS ?? 8_000);
/**
 * Measured on 2026-10-03, four runs each: both relays fast, live in 4.0 to 4.2 s; one relay 8 s slow, 5.5 to 5.8 s with
 * hedged reads, 11.7 to 11.9 s when reads asked the next relay only once the first had answered.
 */
const BOUND_MS = Number(process.env.E2E_SLOW_RELAY_BOUND_MS ?? 9_000);

test("a slow relay does not slow a pairing down: reads take the other relay's answer", {
  tag: ["@feature:core.relay-client"],
}, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("slow-alice"), peer("slow-bob")]);
  let slowed = 0;
  if (SLOW_MS > 0) for (const p of [alice, bob]) {
    // Registered after the fixture's relay, so it runs first: it waits, then hands the request to the test's relay.
    await p.context.route(/^https:\/\/pkarr\.pubky\.org\//, async (route) => {
      slowed++;
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
      await route.fallback().catch(() => { /* the page cancelled it (another relay answered first), or closed */ });
    });
  }
  const started = Date.now();
  await pair(alice, bob);
  const tookMs = Date.now() - started;
  console.log(`[relay-slow] slow relay ${SLOW_MS} ms: paired in ${tookMs} ms (${slowed} requests to the slow relay)`);
  expect(tookMs).toBeLessThan(BOUND_MS);

  await say(alice, "past the slow relay");
  await expect(chat(bob).getByText("past the slow relay")).toBeVisible({ timeout: 20_000 });
});
