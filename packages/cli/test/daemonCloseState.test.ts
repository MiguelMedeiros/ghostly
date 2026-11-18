import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { profilePaths } from "../src/profiles";
import { isolatedNetworkEnv } from "./support/network";
// covers: headless.daemon

/*
 * A daemon's stop (`openHost`'s close, in this process, on a new profile and on this machine's network only). The
 * last state it hands its events (so a one-shot's rename or removal is said) went to every state listener after
 * presence had stopped: presence read the setting on and no timer, and said `active` again with a new timer.
 */
const root = mkdtempSync(join(tmpdir(), "ghostly-daemon-close-"));
const env = { ...isolatedNetworkEnv(), GHOSTLY_WEBRTC: "0" };
const before: Record<string, string | undefined> = {};

beforeAll(() => { for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; process.env[key] = value; } });
afterAll(() => {
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

describe("a daemon that stops", { timeout: 120_000 }, () => {
  it("with daemonPresence on, does not say active again once its presence stopped", async () => {
    const paths = profilePaths(join(root, "home"), "presence");
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    vi.resetModules();
    const { GhostlyNode } = await import("@ghostly/browser/engine/node");
    const said = vi.spyOn(GhostlyNode.prototype, "setPresence");
    const { openHost } = await import("../src/host");
    const { callApi } = await import("../src/api");
    const host = await openHost(paths, "daemon", "test");
    try {
      await callApi(host.ctx, "settings.set", { daemonPresence: true });
      await vi.waitFor(() => expect(said).toHaveBeenCalledWith({ presence: "active" }));
    } catch (error) {
      await host.close();
      throw error;
    }
    said.mockClear();
    await host.close();
    expect(said).not.toHaveBeenCalled();
    said.mockRestore();
  });
});
