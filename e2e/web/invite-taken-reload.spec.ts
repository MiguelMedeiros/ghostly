import { copyInvite, pasteInvite } from "../support/clipboard";
import { expectConnected, expect, test } from "../support/fixtures";
import { LocalRelay } from "../support/relay";

/**
 * A joiner whose look-up pinned the inviter, and who only then read that someone else used the invite first, is told so,
 * and still after a reload: not a working chat "On DHT · retrying live" waiting for a contact paired with someone else.
 * Carol's publications never reach the relay (her app thinks they did), so she pins Alice from the envelope Alice put out
 * before anyone joined, and Alice never hears of her: Bob, who joins after, is the one Alice pairs with.
 */

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, PUT, OPTIONS", "access-control-allow-headers": "*", "access-control-expose-headers": "*" };

test("an invite someone else used after this app looked it up says so, and still after a reload",
  { tag: ["@feature:chat.one-chat", "@feature:chat.paired.pairing-progress", "@feature:chat.paired.progress"] }, async ({ peer }) => {
    test.setTimeout(5 * 60_000);
    const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
    const carol = await peer("carol", { viewport: { width: 375, height: 667 } });
    // Registered after the relay's own route: it answers Carol's publications first, and keeps them.
    await carol.context.route(LocalRelay.pattern, route => route.request().method() === "PUT"
      ? route.fulfill({ status: 204, headers: { ...CORS, date: new Date().toUTCString() } }) : route.fallback());

    await alice.page.getByTitle("New Chat").click();
    const invite = await copyInvite(alice.page);
    await carol.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(carol.page, invite);
    const scene = carol.page.getByTestId("pairing-scene");
    // The look-up found Alice's envelope: Carol pinned her.
    await expect(scene.locator('[data-step="resolving"]')).toHaveAttribute("data-state", "done", { timeout: 60_000 });

    await bob.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(bob.page, invite);
    await expectConnected(alice.page);
    await expectConnected(bob.page);

    // Alice's envelope is sealed to Bob now: Carol reads that, however long her chat has been on the DHT.
    const failure = carol.page.getByTestId("pairing-failure");
    await expect(failure).toContainText("Someone else joined with this invite first", { timeout: 120_000 });

    await carol.page.reload();
    await expect(failure).toContainText("Someone else joined with this invite first", { timeout: 15_000 });
    await carol.page.waitForTimeout(20_000);
    await expect(failure).toContainText("Someone else joined with this invite first");
    await expect(carol.page.getByTestId("connection-options")).not.toHaveAccessibleName(/On DHT · retrying live/);
  });
