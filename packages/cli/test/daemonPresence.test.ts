import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { STATUS_IDLE_AFTER_MS } from "@ghostly/core";
import type { EngineState, Settings } from "@ghostly/browser/shared/types";
import { DaemonPresence, PRESENCE_EVERY_MS } from "../src/daemonPresence";
import { ghostly, home, hyperdhtTestnet, localRelay, ok, Running } from "./support/cli";
// covers: headless.daemon

/** `settings set daemonPresence true`: a running daemon says this profile is active (WISP 401 § Presence and status). */

afterEach(() => { vi.useRealTimers(); });

const state = (settings: Partial<Settings>) => ({ settings }) as unknown as EngineState;

describe("a daemon's presence", () => {
  it("says nothing while the setting is off, as every profile has it", () => {
    const node = { setPresence: vi.fn() };
    const presence = new DaemonPresence(node);
    presence.check(state({}));
    presence.check(state({ daemonPresence: false }));
    expect(node.setPresence).not.toHaveBeenCalled();
  });

  it("on: active at once and again before the engine's 10 minutes to idle; off: taken back at once", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    expect(PRESENCE_EVERY_MS).toBeLessThan(STATUS_IDLE_AFTER_MS);
    const node = { setPresence: vi.fn() };
    const presence = new DaemonPresence(node);
    presence.check(state({ daemonPresence: true }));
    expect(node.setPresence).toHaveBeenLastCalledWith({ presence: "active" });
    // Every state the engine draws is checked: one that leaves the setting as it was says nothing more.
    presence.check(state({ daemonPresence: true }));
    expect(node.setPresence).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PRESENCE_EVERY_MS * 3);
    expect(node.setPresence).toHaveBeenCalledTimes(4);
    expect(node.setPresence.mock.calls.every(([call]) => call.presence === "active")).toBe(true);
    presence.check(state({}));
    expect(node.setPresence).toHaveBeenLastCalledWith({ presence: null });
    vi.advanceTimersByTime(PRESENCE_EVERY_MS * 3);
    expect(node.setPresence).toHaveBeenCalledTimes(5);
  });

  it("stops saying it when the daemon stops", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const node = { setPresence: vi.fn() };
    const presence = new DaemonPresence(node);
    presence.check(state({ daemonPresence: true }));
    presence.stop();
    vi.advanceTimersByTime(PRESENCE_EVERY_MS * 3);
    expect(node.setPresence).toHaveBeenCalledTimes(1);
  });
});

/**
 * Two daemons on loopback (a Pkarr relay in this process and a HyperDHT testnet): Bob's engine shows Alice's dot only
 * while her daemon runs with the setting on, as a person's app shows a contact on the app.
 */
describe("a contact sees a daemon's presence", { timeout: 240_000 }, () => {
  const alice = home("presence-alice"), bob = home("presence-bob");
  const running: Running[] = [];
  let relay: { url: string; server: Server };
  let dht: { bootstrap: string; destroy(): Promise<void> };
  let env: NodeJS.ProcessEnv;
  const as = (dir: string, ...args: string[]) => ghostly(["--home", dir, ...args], { env });
  const start = async (dir: string) => {
    const daemon = new Running(["--home", dir, "daemon"], env);
    running.push(daemon);
    await daemon.waitFor((l) => l.daemon === "ready");
    return daemon;
  };
  /** Alice as Bob's engine has her: the presence the chat's view says. */
  const aliceOnBob = async () => {
    const links = ok(await as(bob, "engine", "getState")).links as { label?: string; peerPresence?: string }[];
    return links.find((link) => link.label === "alice")?.peerPresence;
  };
  const waitPresence = async (want: string | undefined, ms = 30_000) => {
    const until = Date.now() + ms;
    let seen = await aliceOnBob();
    while (seen !== want && Date.now() < until) { await new Promise((r) => setTimeout(r, 500)); seen = await aliceOnBob(); }
    expect(seen).toBe(want);
  };

  beforeAll(async () => {
    relay = await localRelay();
    dht = await hyperdhtTestnet();
    env = { GHOSTLY_HYPERDHT_BOOTSTRAP: dht.bootstrap, GHOSTLY_PKARR_RELAYS: relay.url, GHOSTLY_CALL_BIND: "127.0.0.1" };
  }, 30_000);
  afterAll(async () => {
    await Promise.all(running.map((r) => r.stop()));
    await dht?.destroy();
    relay?.server.close();
  }, 30_000);

  it("none by default; on, off and on again while the daemon runs; gone when it stops; back when it starts", async () => {
    for (const dir of [alice, bob]) ok(await as(dir, "settings", "set", "relays", JSON.stringify([relay.url])));
    const aliceDaemon = await start(alice);
    await start(bob);
    const invite = ok(await as(alice, "invite", "create", "--label", "bob"));
    ok(await as(bob, "invite", "join", invite.link as string, "--label", "alice"));
    for (const [dir, chat] of [[alice, "bob"], [bob, "alice"]]) ok(await as(dir, "chat", "wait", chat, "--until", "live", "--timeout", "90"));
    expect(ok(await as(alice, "settings", "get"))).toMatchObject({ daemonPresence: false });
    // Past the 5 s a status frame may wait: a daemon that never opted in still says nothing.
    await new Promise((r) => setTimeout(r, 6_000));
    expect(await aliceOnBob()).toBeUndefined();

    expect(ok(await as(alice, "settings", "set", "daemonPresence", "true"))).toMatchObject({ daemonPresence: true });
    await waitPresence("active");
    ok(await as(alice, "settings", "set", "daemonPresence", "false"));
    await waitPresence(undefined);
    ok(await as(alice, "settings", "set", "daemonPresence", "true"));
    await waitPresence("active");

    await aliceDaemon.stop();
    await waitPresence(undefined, 60_000);
    // Kept with the profile: the next daemon says it from its start.
    expect(ok(await as(alice, "settings", "get"))).toMatchObject({ daemonPresence: true });
    await start(alice);
    ok(await as(bob, "chat", "wait", "alice", "--until", "live", "--timeout", "90"));
    await waitPresence("active");
  });
});
