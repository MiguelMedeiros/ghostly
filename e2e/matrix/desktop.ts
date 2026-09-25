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
  expect(invite).toMatch(/^pair1\//);
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
 * What a transport value asks of the Desktop side(s), and what the pair should settle on. The browsers have
 * WebRTC only, so a desktop-web pair can only ever meet there; asked for Iroh or HyperDHT alone, it has no
 * live transport in common and must stay usable (texts over the DHT).
 */
function wanted(combo: Combination): { preferred?: Name; fallback: boolean; settles?: Name } {
  const both = combo.client === "desktop-desktop";
  switch (combo.transport) {
    case "webrtc": return { fallback: true, settles: "WebRTC" };
    case "webrtc-strict": return { preferred: "WebRTC", fallback: false, settles: "WebRTC" };
    case "native-fallback": return { preferred: "Iroh", fallback: true, settles: both ? "Iroh" : "WebRTC" };
    case "iroh-only": return { preferred: "Iroh", fallback: false, settles: both ? "Iroh" : undefined };
    case "hyperdht-only": return { preferred: "HyperDHT", fallback: false, settles: both ? "HyperDHT" : undefined };
  }
}

async function transport({ a, b, combo }: DesktopWorld): Promise<void> {
  const want = wanted(combo);
  for (const p of [a, b]) {
    await p.go(p.chatHash!);
    // Only Desktop is asked for a native transport; a browser keeps WebRTC, strict when the value says so.
    const preferred = p.kind === "desktop" ? want.preferred : want.preferred === "WebRTC" ? "WebRTC" : undefined;
    const offered = await p.preferTransport(preferred, p.kind === "desktop" || want.preferred === "WebRTC" ? want.fallback : true);
    if (p.kind === "desktop") expect(offered, `${p.name} (Desktop) offers the native transports`).toEqual(expect.arrayContaining(["Iroh", "HyperDHT"]));
    else expect(offered, `${p.name} (${p.kind}) offers WebRTC only`).toEqual(["WebRTC"]);
  }
  if (want.settles) for (const p of [a, b]) await connected(p, want.settles);
  else for (const p of [a, b]) await expect.poll(() => p.connection(), { timeout: 30_000 }).not.toMatch(/Connected ·/);
  // Live or not, the chat carries text both ways.
  await says(a, b, `over ${combo.transport}`);
  await says(b, a, `back over ${combo.transport}`);
  if (want.settles) for (const p of [a, b]) await connected(p, want.settles);
}

export const DESKTOP_BLOCKS: ReadonlyMap<string, (w: DesktopWorld) => Promise<void>> = new Map(Object.entries({ pair, talk, delivery, transport }));
