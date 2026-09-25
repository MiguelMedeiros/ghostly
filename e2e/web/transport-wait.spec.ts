import { endpoints } from "../infra/env.mjs";
import { chat, connect, expect, link, say, setIrohRelay, test, type Peer } from "../support/fixtures";

// A transport chosen for a chat before the contact's app can take it (WISP 100, "A chosen transport not reached
// yet"). Two browsers with Iroh through the e2e infra's relay; Bob's relay does not answer at first, so his app has
// Iroh but cannot run it yet. Alice chooses Iroh with Fallback off: the chat waits for it on the DHT, says why, and
// never reads "Connection issue". Once Bob's Iroh runs, the switch is tried again by itself and lands.
// The same order on two Linux Desktops with HyperDHT is in the Desktop matrix (e2e/matrix/desktop.ts, hyperdht-only).
test.skip(!process.env.GHOSTLY_IROH_RELAY_URL, "Needs the e2e infra's Iroh relay (npm run e2e:infra:use)");

/** A relay address nothing answers on: Iroh is set up, and cannot come online. */
const DEAD_RELAY = "http://127.0.0.1:9/";
const lines = (peer: Peer) => chat(peer).getByTestId("transport-line");

/** Every label the header shows until `until` matches it, to tell what it said on the way. */
async function labelsUntil(peer: Peer, until: RegExp, timeout: number): Promise<string[]> {
  const seen = new Set<string>();
  await expect.poll(async () => {
    const label = (await peer.page.getByTestId("connection-options").getAttribute("aria-label")) ?? "";
    seen.add(label.replace("Connection options: ", ""));
    return label;
  }, { timeout, intervals: [250] }).toMatch(until);
  return [...seen];
}

test("a transport chosen with Fallback off before the contact's app runs it waits on the DHT, says why, and lands there by itself", {
  tag: ["@feature:transport.wait", "@feature:transport.chat-switch", "@feature:transport.indicator", "@feature:transport.iroh-web"],
}, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const relay = endpoints.irohRelay;
  const [alice, bob] = await Promise.all([peer("alice", { irohRelay: relay }), peer("bob", { irohRelay: DEAD_RELAY })]);
  await link(alice, bob);
  await connect(alice, bob);
  const bobChat = bob.page.url();

  // Alice's app runs Iroh, and Bob's record says his has it (not started yet): she can choose it.
  const icon = alice.page.getByTestId("connection-options");
  await icon.click();
  const iroh = alice.page.getByTestId("connection-option-iroh");
  await expect(iroh).toBeEnabled({ timeout: 90_000 });
  await iroh.click();
  await expect(iroh).toHaveAttribute("aria-checked", "true");
  const fallback = alice.page.getByRole("switch", { name: "Fallback", exact: true });
  await fallback.click();
  await expect(fallback).not.toBeChecked();

  // Waiting, not failing: on the DHT, the panel says why, and nothing reads as a connection issue.
  const waiting = await labelsUntil(alice, /(On DHT · w|W)aiting for Iroh/, 60_000);
  expect(waiting.filter(label => label.includes("Connection issue"))).toEqual([]);
  const block = alice.page.getByTestId("connection-waiting");
  await expect(block).toHaveAttribute("data-transport", "iroh/1");
  await expect(block.getByTestId("connection-waiting-why")).toHaveText(/^You chose Iroh\. /);
  await expect(alice.page.getByRole("alert")).toHaveCount(0);
  await alice.page.keyboard.press("Escape");
  // Bob's side waits too, for Alice's choice, which his app cannot run yet.
  await expect(bob.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /(On DHT · w|W)aiting for Iroh/, { timeout: 60_000 });

  // Short texts still go, over the DHT.
  await say(alice, "while we wait for Iroh");
  await expect(chat(bob).getByText("while we wait for Iroh")).toBeVisible({ timeout: 90_000 });

  // Bob's relay answers now: his Iroh starts, and the chat moves there without anyone choosing again.
  await setIrohRelay(bob.page, relay);
  await bob.page.goto(bobChat);
  const landed = await labelsUntil(alice, /Connected · Iroh/, 180_000);
  expect(landed.filter(label => label.includes("Connection issue"))).toEqual([]);
  await expect(bob.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected · Iroh/, { timeout: 60_000 });

  await say(alice, "over Iroh now");
  await expect(chat(bob).getByText("over Iroh now")).toBeVisible({ timeout: 60_000 });
  await say(bob, "and back");
  await expect(chat(alice).getByText("and back")).toBeVisible({ timeout: 60_000 });

  // The timeline stayed quiet: Alice's choice is the row that became the switch, and no failure was ever a row.
  await expect(lines(alice).filter({ hasText: "You switched to Iroh" })).toHaveCount(1);
  await expect(lines(alice).filter({ hasText: /Couldn't switch|Reconnected|dropped/ })).toHaveCount(0);
  await expect(lines(bob).filter({ hasText: /Couldn't switch|Reconnected|dropped/ })).toHaveCount(0);
});

/** As in one-chat.spec.ts: before the app starts, peer connections made while `__qaRtcBlocked` is on never connect. */
function blockableRtc() {
  const Original = window.RTCPeerConnection;
  const blocked = () => (window as unknown as { __qaRtcBlocked?: boolean }).__qaRtcBlocked === true;
  window.RTCPeerConnection = new Proxy(Original, {
    construct(target, args) {
      const pc = Reflect.construct(target, args) as RTCPeerConnection;
      const setRemote = pc.setRemoteDescription.bind(pc), addCandidate = pc.addIceCandidate.bind(pc);
      pc.setRemoteDescription = (description?: RTCSessionDescriptionInit) => setRemote(blocked() && description?.sdp
        ? { type: description.type, sdp: description.sdp.split("\r\n").filter(line => !line.startsWith("a=candidate")).join("\r\n") }
        : description as RTCSessionDescriptionInit);
      pc.addIceCandidate = ((candidate?: RTCIceCandidateInit) => blocked() ? Promise.resolve() : addCandidate(candidate)) as RTCPeerConnection["addIceCandidate"];
      return pc;
    },
  });
  (window as unknown as { __qaRtcBlocked?: boolean }).__qaRtcBlocked = true;
}

test("a transport chosen while the chat is not live reaches the contact, both say what they wait for, and it lands there", {
  tag: ["@feature:transport.wait", "@feature:transport.timeline", "@feature:transport.preference", "@feature:transport.iroh-web"],
}, async ({ peer }) => {
  // Found between a browser and a desktop whose WebRTC could not connect: the browser chose Iroh on the DHT, and the
  // desktop never heard of it (WISP 100, "A choice made while not live"). Here two browsers with WebRTC blocked, and
  // Bob's Iroh not running yet (its relay does not answer), so nothing goes live until it does.
  test.setTimeout(5 * 60_000);
  const relay = endpoints.irohRelay;
  const [alice, bob] = await Promise.all([peer("alice", { irohRelay: relay }), peer("bob", { irohRelay: DEAD_RELAY })]);
  for (const p of [alice, bob]) { await p.page.addInitScript(blockableRtc); await p.page.reload(); }
  await link(alice, bob);
  for (const p of [alice, bob]) await expect(p.page.getByTestId("connection-options")).toHaveAccessibleName(/On DHT · retrying live/, { timeout: 90_000 });
  const bobChat = bob.page.url();

  // Alice chooses Iroh, Fallback on: nothing to raise a switch intent on, so her capability record carries it.
  await alice.page.getByTestId("connection-options").click();
  const iroh = alice.page.getByTestId("connection-option-iroh");
  await expect(iroh).toBeEnabled({ timeout: 90_000 });
  await iroh.click();
  await expect(iroh).toHaveAttribute("aria-checked", "true");
  await expect(alice.page.getByRole("switch", { name: "Fallback", exact: true })).toBeChecked();
  await alice.page.keyboard.press("Escape");

  // Bob hears of it: one row, as for a choice made on a session.
  await expect(lines(bob).filter({ hasText: /chose Iroh/ })).toHaveCount(1, { timeout: 120_000 });
  // Neither is a silent retry: Alice waits for Bob's Iroh to start, Bob says his app is not running it.
  await expect(alice.page.getByTestId("connection-options")).toHaveAccessibleName(/On DHT · waiting for Iroh/, { timeout: 60_000 });
  await expect(bob.page.getByTestId("connection-options")).toHaveAccessibleName(/On DHT · waiting for Iroh/, { timeout: 60_000 });
  await bob.page.getByTestId("connection-options").click();
  await expect(bob.page.getByTestId("connection-waiting")).toHaveAttribute("data-reason", "app-lacks");
  await expect(bob.page.getByTestId("connection-waiting-why")).toHaveText(/chose Iroh\. This app isn't running Iroh\./);
  await bob.page.keyboard.press("Escape");

  // Bob's relay answers now: his Iroh starts, and the chat goes live there, through the relay.
  await setIrohRelay(bob.page, relay);
  await bob.page.goto(bobChat);
  for (const p of [alice, bob]) await expect(p.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · Iroh \(relayed\)/, { timeout: 180_000 });
  await say(alice, "over Iroh at last");
  await expect(chat(bob).getByText("over Iroh at last")).toBeVisible({ timeout: 60_000 });
});
