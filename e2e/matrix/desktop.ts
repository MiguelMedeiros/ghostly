import { join } from "node:path";
import { expect, type TestInfo } from "@playwright/test";
import { desktopHome } from "../support/desktop";
import type { LocalRelay } from "../support/relay";
import type { Combination } from "./dimensions";
import { desktopPerson, type Person } from "./people";

/**
 * The chat blocks of a scenario with a Desktop peer (`desktop-web`, `desktop-desktop`), on the Person
 * interface (people.ts), so each one runs with Desktop driven through WebDriver on either side. What the
 * Desktop peer does not drive (files, wallets, proofs, groups, backups) is left out by the plan (plan.ts)
 * with the reason.
 *
 * Desktop's peer does not meet the test's relay by request interception like the browsers do: each app is
 * started with GHOSTLY_PKARR_RELAYS pointing at it (the relay's own HTTP listener), and with
 * GHOSTLY_HYPERDHT_BOOTSTRAP at a HyperDHT testnet in the test process, so nothing leaves the machine.
 */
export interface DesktopWorld {
  combo: Combination;
  info: TestInfo;
  a: Person;
  b: Person;
  cleanup: (() => Promise<void> | void)[];
}

/** The HyperDHT testnet the Desktop runtime's own dependency graph ships (scripts/prepare-native-runtime.mjs installs it). */
export const HYPERDHT_TESTNET = join(import.meta.dirname, "..", "..", "native-transports", "hyperdht", "node_modules", "hyperdht", "testnet.js");

/**
 * What a Desktop app of the scenario needs from the test process: the relay, and a HyperDHT network of its
 * own. Made once per scenario; `close` ends the network.
 */
export async function desktopNetwork(relay: LocalRelay): Promise<{ env: Record<string, string>; close: () => Promise<void> }> {
  const { default: testnet } = (await import(HYPERDHT_TESTNET)) as { default: (size: number) => Promise<{ bootstrap: { host: string; port: number }[]; destroy(): Promise<void> }> };
  const net = await testnet(3);
  return {
    env: { GHOSTLY_PKARR_RELAYS: await relay.listen(), GHOSTLY_HYPERDHT_BOOTSTRAP: net.bootstrap.map((node) => `${node.host}:${node.port}`).join(",") },
    close: () => net.destroy(),
  };
}

/** One Desktop person with a home of its own, removed with the scenario. */
export async function openDesktopPerson(w: Pick<DesktopWorld, "cleanup">, name: string, env: Record<string, string>): Promise<Person> {
  const home = desktopHome(name);
  const person = await desktopPerson(name, { home: home.dir, env });
  w.cleanup.push(async () => { await person.stop(); home.remove(); });
  return person;
}

const written = (p: Person, text: string, timeout = 120_000) => expect.poll(() => p.shows(text), { timeout, message: `${p.name} sees “${text}”` }).toBe(true);
const connected = (p: Person, transport: string, timeout = 180_000) =>
  expect.poll(() => p.connection(), { timeout, message: `${p.name} is connected over ${transport}` }).toMatch(new RegExp(`Connected · ${transport}`));

async function pair({ a, b }: DesktopWorld): Promise<void> {
  await a.press("New Chat");
  const invite = await a.copyInvite();
  expect(invite).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p/);
  await b.join(invite);
  for (const p of [a, b]) {
    await expect.poll(() => p.canWrite(), { timeout: 120_000, message: `${p.name}'s chat is up` }).toBe(true);
    p.chatHash = await p.hash();
  }
  expect(a.chatHash).toMatch(/^#\/chat\//);
}

/**
 * Without a live link a chat's texts go over the DHT, one awaiting its receipt at a time
 * (packages/core/src/dhtDelivery.ts): the next one waits for it, as a person would be told to.
 */
const receipted = (p: Person) =>
  expect.poll(() => p.awaitingReceipt(), { timeout: 180_000, message: `${p.name}'s last text is received` }).toBe(false);

async function says(from: Person, to: Person, text: string): Promise<void> {
  await from.say(text);
  await written(to, text, 180_000);
  await receipted(from);
}

async function talk({ a, b }: DesktopWorld): Promise<void> {
  // No emoji: WebKitGTK draws one as an image, which a text match does not see.
  await says(b, a, `boo from ${b.name}`);
  await says(a, b, `olá from ${a.name}`);
}

/** B leaves (the page, or the whole app), A writes, B comes back to it. */
async function delivery({ a, b }: DesktopWorld): Promise<void> {
  const back = await b.away();
  await a.say("are you there?");
  await back();
  await written(b, "are you there?", 240_000);
  await receipted(a);
}

type Name = "WebRTC" | "Iroh" | "HyperDHT";

/**
 * What a transport value asks of each side, and where the pair should end up (a pattern of transport names), or
 * nowhere live. The matrix's Desktop runs on Linux, whose WebKitGTK has no WebRTC at all:
 *
 * - Desktop ↔ Desktop opens on the DHT and goes live natively from the descriptors in each other's capability
 *   record (e2e/desktop/native-upgrade.spec.ts). The default (`webrtc`: Automatic, fallback on) settles on
 *   either native transport. Asked for WebRTC only, a Desktop cannot choose it (its option is off, with the
 *   reason), and Fallback off keeps it to the app's first transport: Iroh. Iroh alone, or first, settles on Iroh;
 *   HyperDHT alone on HyperDHT.
 * - Desktop ↔ web: the browser has WebRTC only (its fixture keeps Iroh off, and HyperDHT needs a relay it is not
 *   given), the Desktop has no WebRTC, so whatever is asked they have no live transport in common and the chat
 *   stays usable on the DHT.
 */
function wanted(combo: Combination): { preferred?: Name; fallback: boolean; settles?: string } {
  const both = combo.client === "desktop-desktop";
  switch (combo.transport) {
    case "webrtc": return { fallback: true, settles: both ? "Iroh|HyperDHT" : undefined };
    case "webrtc-strict": return { preferred: "WebRTC", fallback: false, settles: both ? "Iroh" : undefined };
    case "native-fallback": return { preferred: "Iroh", fallback: true, settles: both ? "Iroh" : undefined };
    case "iroh-only": return { preferred: "Iroh", fallback: false, settles: both ? "Iroh" : undefined };
    case "hyperdht-only": return { preferred: "HyperDHT", fallback: false, settles: both ? "HyperDHT" : undefined };
  }
}

const notLive = (p: Person) => expect.poll(() => p.connection(), { message: `${p.name} is not live` }).not.toMatch(/Connected ·/);

/**
 * Connected over `transport` in the end, and never "Connection issue" on the way: a chosen transport not reached yet
 * is waited for (WISP 100, "On DHT · waiting for HyperDHT"), not a failure.
 */
async function settlesWithoutIssue(p: Person, transport: string, timeout = 180_000): Promise<void> {
  const seen = new Set<string>();
  await expect.poll(async () => { const label = await p.connection(); seen.add(label); return label; },
    { timeout, message: `${p.name} is connected over ${transport}` }).toMatch(new RegExp(`Connected · ${transport}`));
  expect([...seen].filter(label => /Connection issue/.test(label)), `${p.name} waited without a connection issue (saw: ${[...seen].join(" / ")})`).toEqual([]);
}

async function transport({ a, b, combo }: DesktopWorld): Promise<void> {
  const want = wanted(combo);
  const both = combo.client === "desktop-desktop";
  for (const p of [a, b]) await p.go(p.chatHash!);
  // Two Desktops go live by themselves first, natively from the DHT (native-upgrade.spec.ts), and the preferences act
  // on that, as a person meets the menu. HyperDHT alone is the exception: it is asked for before the pair is live, the
  // order that once left the chat on "Connection issue" for good (#244: chosen before the contact's record named
  // HyperDHT, the switch failed and nothing tried it again). The chat now waits for it (WISP 100) and lands there.
  const early = both && combo.transport === "hyperdht-only";
  if (both && !early) for (const p of [a, b]) await connected(p, "(?:Iroh|HyperDHT)");
  for (const p of [a, b]) {
    // The premise of `wanted`: Desktop here is Linux, with no WebRTC.
    if (p.kind === "desktop") expect((await p.callButton()).rtc, `${p.name} (Desktop on Linux) has no WebRTC`).toBe(false);
    // Only Desktop is asked for a native transport; a browser keeps WebRTC, strict when the value says so.
    const preferred = p.kind === "desktop" ? want.preferred : want.preferred === "WebRTC" ? "WebRTC" : undefined;
    const fallback = p.kind === "desktop" || want.preferred === "WebRTC" ? want.fallback : true;
    // The options are off for what this app lacks, and for what the contact's lacks (as far as it has learned): a
    // Desktop offers its native transports to a Desktop, and nothing to a browser, which has WebRTC only.
    await expect(async () => {
      const offered = await p.preferTransport(preferred, fallback);
      if (p.kind === "desktop") expect(offered, `${p.name} (Desktop) offers what both apps have`).toEqual(both ? ["Iroh", "HyperDHT"] : []);
      else expect(["WebRTC"], `${p.name} (${p.kind}) offers WebRTC at most`).toEqual(expect.arrayContaining(offered));
    }).toPass({ timeout: 60_000 });
  }
  if (early) for (const p of [a, b]) await settlesWithoutIssue(p, `(?:${want.settles})`);
  else if (want.settles) for (const p of [a, b]) await connected(p, `(?:${want.settles})`);
  else for (const p of [a, b]) await notLive(p);
  // Live or not, the chat carries text both ways.
  await says(a, b, `over ${combo.transport}`);
  await says(b, a, `back over ${combo.transport}`);
  // And stays where it settled: the texts over the DHT took minutes, time enough to have gone live if it could.
  if (want.settles) for (const p of [a, b]) await connected(p, `(?:${want.settles})`);
  else for (const p of [a, b]) await notLive(p);
}

/**
 * Calls in the chat (`calls/1`). Call media is a WebRTC connection of its own, whatever carries the chat, so a
 * client without WebRTC (Desktop on Linux: WebKitGTK) cannot call: its buttons say so, and a live contact's say
 * the contact cannot take calls. Where both sides can, a call is placed, answered and ended.
 */
async function calls({ a, b }: DesktopWorld): Promise<void> {
  for (const p of [a, b]) await p.go(p.chatHash!);
  const rtc = new Map<Person, boolean>();
  for (const p of [a, b]) rtc.set(p, (await p.callButton()).rtc);
  const reason = async (p: Person, other: Person): Promise<string | null> => {
    if (!rtc.get(p)) return "Calls are not available in this app";
    if (!/Connected ·/.test(await p.connection())) return "Calls need a live connection";
    return rtc.get(other) ? null : "Your contact's app cannot take calls";
  };
  for (const [p, other] of [[a, b], [b, a]] as const) {
    await expect.poll(async () => {
      const [button, want] = [await p.callButton(), await reason(p, other)];
      return button.title === (want ?? "Audio call") && button.disabled === !!want;
    }, { timeout: 60_000, message: `${p.name}'s call button says why it is off, or is on` }).toBe(true);
  }
  if (await reason(a, b) || await reason(b, a)) return;
  await a.press("Audio call");
  await b.press("Accept audio call");
  await b.press("End call");
  await expect.poll(async () => (await a.snapshot()).includes("Audio call ended"), { timeout: 60_000 }).toBe(true);
}

export const DESKTOP_BLOCKS: ReadonlyMap<string, (w: DesktopWorld) => Promise<void>> = new Map(Object.entries({ pair, talk, delivery, transport, calls }));
