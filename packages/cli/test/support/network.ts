/**
 * The network a test's `ghostly` runs on: this machine only. Nothing it starts reaches a public Pkarr relay, the
 * Mainline DHT, the HyperDHT's public bootstrap nodes, n0's Iroh relays or Google's STUN servers, unless the run opts
 * in with `GHOSTLY_TEST_PUBLIC_NET=1`. Shared by the CLI's tests (./cli.ts) and the web e2e's headless bots
 * (e2e/support/headless.ts). No Vitest here: Playwright imports it too.
 *
 * A test that needs a working network brings its own on loopback: `localRelay()` for Pkarr (its URL in
 * `GHOSTLY_PKARR_RELAYS`), `hyperdhtTestnet()` for the HyperDHT, a Mainline testnet in `GHOSTLY_DHT_BOOTSTRAP`, the
 * e2e infra's Iroh relay (`GHOSTLY_IROH_RELAY_URL`, used when the shell has it).
 */

/** The opt-in: public networks, for a run that needs them. */
export const PUBLIC_NET_OPT_IN = "GHOSTLY_TEST_PUBLIC_NET";

/** Nothing listens there: every request is refused at once. */
const NOWHERE = "127.0.0.1:9";

export const publicNetOptedIn = (env: NodeJS.ProcessEnv = process.env): boolean => env[PUBLIC_NET_OPT_IN] === "1";

/**
 * The environment every `ghostly` a test starts gets first (a test's own goes over it): loopback or nowhere for each
 * network. With the opt-in, the Mainline DHT stays off still (no test needs it public) and the rest is the app's.
 */
export function isolatedNetworkEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (publicNetOptedIn(env)) return { GHOSTLY_DHT: "0" };
  return {
    GHOSTLY_DHT: "0",
    GHOSTLY_PKARR_RELAYS: `http://${NOWHERE}`,
    GHOSTLY_HYPERDHT_BOOTSTRAP: NOWHERE,
    GHOSTLY_IROH_RELAYS: env.GHOSTLY_IROH_RELAY_URL || `http://${NOWHERE}`,
    GHOSTLY_STUN: "0",
  };
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** `host:port` or a URL: on this machine. A value the CLI refuses (not a URL) reaches nothing. */
function local(value: string, url: boolean): boolean {
  if (!url) return LOOPBACK.has(value.replace(/:\d+$/, ""));
  if (!/^https?:\/\//i.test(value)) return true;
  try { return LOOPBACK.has(new URL(value).hostname); } catch { return true; }
}

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/**
 * What in this environment would take a `ghostly` to a public network: one line each, none when it stays on this
 * machine. Read as the CLI reads it (packages/cli/src/runtime/engine.ts).
 */
export function publicNetworkIn(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const pkarr = list(env.GHOSTLY_PKARR_RELAYS);
  // Set empty on purpose: the profile's own relays, which that test set on loopback (test/mainline.test.ts).
  if (env.GHOSTLY_PKARR_RELAYS === undefined) out.push("Pkarr: no GHOSTLY_PKARR_RELAYS, so the profile's relays (public by default)");
  for (const relay of pkarr) if (!local(relay, true)) out.push(`Pkarr relay ${relay}`);
  if (env.GHOSTLY_DHT !== "0") {
    const nodes = list(env.GHOSTLY_DHT_BOOTSTRAP);
    if (!nodes.length && !pkarr.length) out.push("Mainline DHT: on, with its public routers");
    for (const node of nodes) if (!local(node, false)) out.push(`Mainline DHT node ${node}`);
  }
  const hyperdht = list(env.GHOSTLY_HYPERDHT_BOOTSTRAP);
  if (!hyperdht.length) out.push("HyperDHT: no GHOSTLY_HYPERDHT_BOOTSTRAP, so its public bootstrap nodes");
  for (const node of hyperdht) if (!local(node, false)) out.push(`HyperDHT node ${node}`);
  const iroh = list(env.GHOSTLY_IROH_RELAYS);
  if (!iroh.length) out.push("Iroh: no GHOSTLY_IROH_RELAYS, so the profile's relays (n0's public ones by default)");
  for (const relay of iroh) if (!local(relay, true)) out.push(`Iroh relay ${relay}`);
  if (env.GHOSTLY_WEBRTC !== "0" && env.GHOSTLY_STUN !== "0") out.push("WebRTC: the apps' public STUN servers (no GHOSTLY_STUN=0)");
  return out;
}

/** The environment a test's `ghostly` runs with: isolated, and refused if a test's own takes it out without the opt-in. */
export function testNetworkEnv(...layers: (NodeJS.ProcessEnv | undefined)[]): NodeJS.ProcessEnv {
  const given: NodeJS.ProcessEnv = Object.assign({}, process.env, ...layers);
  const env: NodeJS.ProcessEnv = { ...isolatedNetworkEnv(given), ...given };
  if (!publicNetOptedIn(env)) {
    const problems = publicNetworkIn(env);
    if (problems.length) throw new Error(`A test's ghostly would reach a public network (${PUBLIC_NET_OPT_IN}=1 allows it):\n- ${problems.join("\n- ")}`);
  }
  return env;
}

/*
 * Ghostly Desktop under the e2e drivers (e2e/support/desktopMac.ts on macOS, e2e/support/desktop.ts on Linux and
 * Windows). It reads other knobs than the CLI: `GHOSTLY_PKARR_RELAYS` alone means those relays and no Mainline DHT,
 * `GHOSTLY_PKARR_DHT_BOOTSTRAP` a Mainline DHT of one's own (apps/desktop/src/pkarr_network.rs), `GHOSTLY_IROH_RELAYS`
 * (apps/desktop/src/paired_transport.rs) and `GHOSTLY_HYPERDHT_BOOTSTRAP` (native/transports/hyperdht/sidecar.mjs).
 * WebRTC's STUN servers have no knob on Desktop: the WebView's own list stays.
 */

/** What a Desktop app under test gets first (a test's own goes over it). With the opt-in: nothing, the app's own networks. */
export function isolatedDesktopNetworkEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (publicNetOptedIn(env)) return {};
  return {
    GHOSTLY_PKARR_RELAYS: `http://${NOWHERE}`,
    GHOSTLY_HYPERDHT_BOOTSTRAP: NOWHERE,
    GHOSTLY_IROH_RELAYS: env.GHOSTLY_IROH_RELAY_URL || `http://${NOWHERE}`,
  };
}

/** What in this environment would take a Desktop app to a public network: one line each, none when it stays here. */
export function desktopPublicNetworkIn(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const pkarr = list(env.GHOSTLY_PKARR_RELAYS);
  if (!pkarr.length) out.push("Pkarr: no GHOSTLY_PKARR_RELAYS, so the public relays and the public Mainline DHT");
  for (const relay of pkarr) if (!local(relay, true)) out.push(`Pkarr relay ${relay}`);
  for (const node of list(env.GHOSTLY_PKARR_DHT_BOOTSTRAP)) if (!local(node, false)) out.push(`Mainline DHT node ${node}`);
  const hyperdht = list(env.GHOSTLY_HYPERDHT_BOOTSTRAP);
  if (!hyperdht.length) out.push("HyperDHT: no GHOSTLY_HYPERDHT_BOOTSTRAP, so its public bootstrap nodes");
  for (const node of hyperdht) if (!local(node, false)) out.push(`HyperDHT node ${node}`);
  const iroh = list(env.GHOSTLY_IROH_RELAYS);
  if (!iroh.length) out.push("Iroh: no GHOSTLY_IROH_RELAYS, so n0's public relays");
  for (const relay of iroh) if (!local(relay, true)) out.push(`Iroh relay ${relay}`);
  return out;
}

/**
 * The environment a Desktop app under test starts with: this process's, the isolated defaults under it, the layers
 * over it. Refused if it would reach a public network without the opt-in.
 */
export function desktopTestNetworkEnv(...layers: (NodeJS.ProcessEnv | undefined)[]): Record<string, string> {
  const given: NodeJS.ProcessEnv = Object.assign({}, process.env, ...layers);
  const env = { ...isolatedDesktopNetworkEnv(given), ...given };
  if (!publicNetOptedIn(env)) {
    const problems = desktopPublicNetworkIn(env);
    if (problems.length) throw new Error(`A test's Desktop app would reach a public network (${PUBLIC_NET_OPT_IN}=1 allows it):\n- ${problems.join("\n- ")}`);
  }
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
