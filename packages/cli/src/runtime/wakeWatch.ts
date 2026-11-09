import { networkInterfaces } from "node:os";

/**
 * A page hears `visibilitychange` and `online` and calls the engine's `wake` (every chat looks now, a dropped one
 * redials, relays left alone on the old network are asked again). A daemon on Node hears neither: after a laptop slept
 * or the machine moved to another network, its chats waited out their background pace and its relay back-offs, and a
 * contact (a phone opening the app) found it minutes later or not until a restart.
 *
 * This watch stands in for those events. A tick that comes far later than it was due means the machine slept (timers do
 * not run in sleep); a different set of the machine's own addresses means it changed networks. Either calls `onWake`
 * once, with `network: true` (after a sleep the network may well be another one too, and asking a relay again is cheap).
 */
export const WAKE_TICK_MS = 10_000;
/** A tick this much later than due: the process was not running (sleep, a stopped process), not merely busy. */
export const WAKE_LATE_MS = 30_000;

/**
 * The machine's own virtual bridges, for containers and VMs on it: Docker's (`docker0`, a compose network's `br-<id>`,
 * `veth*`), libvirt's, CNI's, LXD's, VirtualBox's and VMware's host networks, macOS's `bridge100` (sharing, a VM), and
 * Windows's WSL and Default Switch. A container network made or removed changes them with nothing changed for the
 * internet, and a network wake clears the relays' back-off. A Hyper-V switch bound to the network card (`vEthernet
 * (External)`) holds the machine's real address and stays.
 */
const LOCAL_BRIDGE = /^(docker\d*|br-[0-9a-f]+|veth.*|virbr\d+|cni\d+|flannel.*|cali.*|lxcbr\d+|lxdbr\d+|incusbr\d+|podman\d+|vboxnet\d+|vmnet\d+|bridge\d+|vEthernet \((WSL.*|Default Switch)\))$/;

/** The machine's own non-internal addresses, sorted: a change means another network (Wi-Fi to cable, a new DHCP lease). */
export function addressesKey(nets: ReturnType<typeof networkInterfaces> = networkInterfaces()): string {
  const out: string[] = [];
  for (const [name, list] of Object.entries(nets)) {
    if (LOCAL_BRIDGE.test(name)) continue;
    for (const entry of list ?? []) {
      // Link-local IPv6 comes and goes with nothing changed for the internet; skip it with loopback.
      if (entry.internal || (entry.family === "IPv6" && entry.address.toLowerCase().startsWith("fe80"))) continue;
      out.push(`${name}/${entry.address}`);
    }
  }
  return out.sort().join(",");
}

export interface WakeWatchOptions {
  tickMs?: number;
  lateMs?: number;
  now?: () => number;
  addresses?: () => string;
}

/** Starts the watch; the returned function stops it. The timer never keeps the process alive. */
export function watchWake(onWake: (why: "sleep" | "network") => void, options: WakeWatchOptions = {}): () => void {
  const tickMs = options.tickMs ?? WAKE_TICK_MS;
  const lateMs = options.lateMs ?? WAKE_LATE_MS;
  const now = options.now ?? Date.now;
  const addresses = options.addresses ?? (() => addressesKey());
  let last = now();
  let key = safe(addresses);
  const timer = setInterval(() => {
    const at = now();
    const slept = at - last > tickMs + lateMs;
    last = at;
    const next = safe(addresses);
    // An empty read (no network at all, or the call failed) is not a new network: the next real one is, the same
    // network coming back included (relays left alone while it was gone are asked again).
    const moved = next !== "" && next !== key;
    key = next;
    if (slept || moved) {
      try { onWake(slept ? "sleep" : "network"); } catch { /* the engine's own wake logs its trouble */ }
    }
  }, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function safe(read: () => string): string {
  try { return read(); } catch { return ""; }
}
