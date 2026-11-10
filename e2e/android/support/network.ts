import { networkInterfaces } from "node:os";
import type { Adb } from "./android";

/**
 * The emulator's IPv4 way out to this machine, which a call's media needs: the app's WebRTC (in its WebView) sends to
 * the web peer's host candidates, this machine's own addresses (eth0, docker0), through the emulator's NAT (10.0.2.2,
 * the default route on wlan0). Everything else the specs use goes through `adb reverse` (the relays on 127.0.0.1), so a
 * device without that route still pairs, chats and sends files, and only a call never connects.
 *
 * That happened on CI (2026-11-10): Android set wlan0 up while its address was being configured again, and adding the
 * default route via 10.0.2.2 failed (`networkAddRouteParcel(… 0.0.0.0/0 … nextHop: 10.0.2.2) -> "Network is unreachable"`)
 * and was never tried again; the emulator's eth0 network never came either. The device kept only 10.0.2.0/24 on-link
 * and an IPv6 default route, the WebView dropped every packet to the web peer's IPv4 candidates (`sendto() has failed
 * twice … net::ERR_ADDRESS_UNREACHABLE`, about 30 a second during each call), ICE failed, and both backgroundCall
 * tests failed with their retries. Turning Wi-Fi off and on again makes Android provision wlan0 from scratch.
 */

/** This machine's IPv4 addresses the web peer offers as host candidates; the emulator's own subnet left out. */
export function hostAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((info) => info && info.family === "IPv4" && !info.internal && !info.address.startsWith("10.0.2."))
    .map((info) => info!.address);
}

/** The device's route to `address` (`ip route get`), or null when it has none. */
export function routeTo(adb: Adb, address: string): string | null {
  const { ok, out } = adb.tryRun("shell", "ip", "-4", "route", "get", address);
  const line = out.trim().split("\n")[0] ?? "";
  if (!ok || /unreachable|prohibit|blackhole|RTNETLINK|error/i.test(line) || !/\bdev\s+\S+/.test(line)) return null;
  return line;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Makes sure the device routes IPv4 to `target` (one of `hostAddresses`), turning Wi-Fi off and on (at most twice) when it does not. Null
 * when it does (at once or after that); otherwise what is missing, for the test's annotations: a call then cannot
 * connect, and the spec that needs one says so instead of waiting for its clock.
 */
export async function ensureHostRoute(adb: Adb, target: string, log: (line: string) => void = console.log): Promise<string | null> {
  if (routeTo(adb, target)) return null;
  const before = deviceNetwork(adb);
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`  [android] no IPv4 route to ${target} on the device: Wi-Fi off and on (${attempt}/2)`);
    adb.tryRun("shell", "svc", "wifi", "disable");
    await sleep(3_000);
    adb.tryRun("shell", "svc", "wifi", "enable");
    const end = Date.now() + 45_000;
    while (Date.now() < end) {
      await sleep(1_000);
      const route = routeTo(adb, target);
      if (route) {
        log(`  [android] IPv4 route back: ${route}`);
        return null;
      }
    }
  }
  return `The emulator has no IPv4 route to this machine (${target}), even after Wi-Fi off and on twice: a call's media cannot reach the web peer.\n${before}`;
}

/** The device's addresses, routes and rules, and this machine's addresses: what a call that never connected had to go through. */
export function deviceNetwork(adb: Adb): string {
  const run = (...args: string[]) => {
    const { out } = adb.tryRun("shell", ...args);
    return `$ ${args.join(" ")}\n${out.trim()}`;
  };
  const host = Object.entries(networkInterfaces()).map(([name, infos]) => `${name}: ${(infos ?? []).map((i) => `${i.address}/${i.netmask}`).join(", ")}`);
  return [
    run("ip", "addr"),
    run("ip", "-4", "route", "show", "table", "all"),
    run("ip", "-6", "route", "show", "table", "all"),
    run("ip", "rule"),
    ...hostAddresses().map((address) => `$ ip -4 route get ${address}\n${routeTo(adb, address) ?? "(no route)"}`),
    `this machine:\n${host.join("\n")}`,
  ].join("\n\n");
}
