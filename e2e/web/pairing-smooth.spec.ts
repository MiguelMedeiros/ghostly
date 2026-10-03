import { copyInvite, pasteInvite } from "../support/clipboard";
import { expect, test, type Peer } from "../support/fixtures";
import { pairingFrames, pairingGlitches, watchPairing } from "../support/pairingWatch";

/**
 * A pairing tells one story, smoothly: the scene walks its steps forward only, nothing on screen blanks and comes
 * back, the connection icon says what the scene says, and the scene ends as the chat goes live (its short "connected"
 * moment over a chat that already works). A reconnect afterwards belongs to the icon: the scene does not come back,
 * and the chat list stays as it is.
 */

/** STUN is answered in the test process (support/stun.ts): Google's servers may answer late. */
const PAIRING = { localStun: true, beforeOpen: watchPairing };
/** The scene's "connected" moment (CELEBRATE_MS, 1.8 s), and room for a busy machine. */
const LEAVE_WITHIN_MS = 3_000;

const live = (peer: Peer) => expect(peer.page.getByTestId("connection-options")).toHaveAccessibleName(/^Connection options: Connected · /, { timeout: 90_000 });

test("a new pairing walks forward only, keeps its words on screen, agrees with the icon, and ends as the chat goes live; a reconnect leaves it gone", { tag: ["@feature:chat.paired.pairing-progress", "@feature:chat.paired.pair"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all(["smooth-alice", "smooth-bob"].map(name => peer(name, PAIRING)));
  await alice.page.getByTitle("New Chat").click();
  await expect(alice.page.getByTestId("pairing-scene")).toHaveAttribute("data-stage", "waiting");
  const invite = await copyInvite(alice.page);
  await bob.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(bob.page, invite);

  for (const p of [alice, bob]) await live(p);
  for (const p of [alice, bob]) await expect(p.page.getByTestId("pairing-scene")).toHaveCount(0, { timeout: 10_000 });
  for (const p of [alice, bob]) {
    const frames = await pairingFrames(p.page);
    expect(frames.some(f => f.scene), `${p.name} saw no scene`).toBe(true);
    expect(pairingGlitches(frames, { leaveWithinMs: LEAVE_WITHIN_MS }), p.name).toEqual([]);
  }

  // Bob's app restarts: Alice's chat goes off live and back, under its icon. Her scene does not come back, and her
  // chat list never blanks; Bob's chat opens on the chat, not on a pairing.
  await bob.page.reload();
  await bob.page.getByTestId("chat-row").first().click();
  for (const p of [alice, bob]) await live(p);
  for (const p of [alice, bob]) {
    const frames = await pairingFrames(p.page);
    expect(pairingGlitches(frames, { leaveWithinMs: LEAVE_WITHIN_MS }), p.name).toEqual([]);
  }
  expect((await pairingFrames(bob.page)).some(f => f.scene), "the scene on a reconnect").toBe(false);
});
