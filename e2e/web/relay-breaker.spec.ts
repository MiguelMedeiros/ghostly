import { chat, expect, say, test } from "../support/fixtures";
import { connectionDetails, pair } from "../support/paired";

/**
 * A relay that keeps failing is left alone (its circuit breaker, packages/core/src/relayBreaker.ts): three
 * failures in a row and no request goes to it for a minute, while the other relays take its turns. Here one of
 * the default relays answers every request with a 503; two people still pair through the others, and the
 * connection panel's Details say which relay is failing and which path discovery took.
 */
test("a failing relay trips its breaker, and pairing goes on through the others", {
  tag: ["@feature:core.relay-breaker", "@feature:chat.paired.discovery-health"],
}, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("breaker-alice"), peer("breaker-bob")]);
  const asked: string[] = [];
  for (const p of [alice, bob]) {
    // Registered after the fixture's relay: this one answers for pkarr.pubky.app.
    await p.context.route(/^https:\/\/pkarr\.pubky\.app\//, (route) => {
      asked.push(`${p.name} ${route.request().method()}`);
      return route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" } });
    });
  }
  await pair(alice, bob);
  await say(alice, "through the other relays");
  await expect(chat(bob).getByText("through the other relays")).toBeVisible();

  await connectionDetails(alice);
  const relay = (host: string) => alice.page.locator(`[data-testid="connection-relay"][data-relay="${host}"]`);
  await expect(relay("pkarr.pubky.app")).toHaveAttribute("data-state", "failing");
  await expect(relay("pkarr.pubky.app")).toContainText(/failing until \d/);
  await expect(relay("pkarr.pubky.org")).toHaveAttribute("data-state", "ok");
  await expect(alice.page.getByTestId("connection-discovery-path")).toHaveText(/^Relay: (pkarr\.pubky\.org|relay\.pkarr\.org)$/);

  // Tripped: nothing more goes to it while it waits, however the others are used meanwhile.
  const seen = asked.filter((a) => a.startsWith("breaker-alice")).length;
  await say(bob, "and back");
  await expect(chat(alice).getByText("and back")).toBeVisible();
  await alice.page.waitForTimeout(3_000);
  expect(asked.filter((a) => a.startsWith("breaker-alice")).length, asked.join(", ")).toBe(seen);
});
