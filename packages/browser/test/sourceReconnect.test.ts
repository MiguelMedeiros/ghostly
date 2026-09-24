import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { STORES, transact } from "../src/shared/idb";
import { ProviderSources, RETRY_MAX_MS, SUSTAINED_MS, retryDelay } from "../src/engine/paymentAdapters/providers/sources";
import { SourceConfigError, SourceUnreachableError, providerDescriptorProblems, type ProviderDescriptor, type ProviderNetwork, type ProviderSettings } from "../src/engine/paymentAdapters/providers/types";
// covers: wallet.onchain.sources, wallet.lightning.sources

/**
 * A saved source that cannot be reached when the app starts (a slow server, one that is down, no network
 * yet) is tried again by itself with backoff: "Connecting…" with the last balance it read, "Unavailable"
 * only once the failure is sustained, and connected as soon as the server answers again. Retry and waking
 * up try at once; "Change server" moves a saved source to another server keeping its secrets.
 */

type Node = { info(): Promise<{ network: ProviderNetwork; alias?: string }>; close: Mock<() => Promise<void>>; server: string; secret?: string };
const node = (settings: ProviderSettings): Node => ({ info: async () => ({ network: "regtest", alias: `via ${settings.config.server}` }), close: vi.fn(async () => {}), server: settings.config.server, secret: settings.secrets.key });

/** A server that can be up, down (refuses at once), slow (answers when told) or on the wrong chain. */
class Server {
  state: "up" | "down" | "slow" | "wrong" = "up";
  attempts = 0;
  private waiting: (() => void)[] = [];
  answer() { for (const go of this.waiting.splice(0)) go(); }
  async connect(settings: ProviderSettings): Promise<Node> {
    this.attempts++;
    if (this.state === "down") throw new SourceUnreachableError(`nothing answers at ${settings.config.server}`);
    if (this.state === "wrong") throw new SourceConfigError(`wrong network: ${settings.config.server} is on another chain`);
    if (this.state === "slow") await new Promise<void>((resolve) => this.waiting.push(resolve));
    return node(settings);
  }
}

const descriptor = (server: Server, fields: ProviderDescriptor<Node>["fields"] = [{ name: "server", label: "Server", kind: "url", changeable: true }, { name: "account", label: "Account", kind: "text", optional: true }]): ProviderDescriptor<Node> => ({
  id: "node", label: "Node", kind: "onchain", description: "A node", networks: ["regtest"], platforms: ["web"], fields,
  create: (settings) => server.connect(settings),
});

const all: ProviderSources<Node>[] = [];
function sources(server: Server, extra: { fields?: ProviderDescriptor<Node>["fields"]; balance?: () => number; backoff?: number } = {}) {
  const changed = vi.fn();
  const s = new ProviderSources<Node>({
    kind: "onchain", descriptors: () => [descriptor(server, extra.fields)], host: () => ({ platform: "web" }), changed,
    backoff: (failures) => extra.backoff ?? 20 * failures,
    refresh: async () => ({ balance: extra.balance?.() ?? 1_234, unconfirmed: 5 }),
    refreshMs: 60_000,
  });
  all.push(s);
  return { s, changed };
}
/** Saves a source (the server up), then "restarts" the app: a new engine reads what was saved. */
async function saved(server: Server, values: Record<string, string> = { server: "https://a.example" }, extra: Parameters<typeof sources>[1] = {}) {
  const first = sources(server, extra).s;
  await first.start("testnet");
  await first.set("node", values);
  await vi.waitFor(() => expect(first.view.balance).toBeDefined());
  await first.stop();
  const restarted = sources(server, extra);
  await restarted.s.start("testnet");
  return restarted;
}

beforeEach(async () => { await transact([STORES.settings], (s) => { s[STORES.settings].clear(); }); });
afterEach(async () => { vi.useRealTimers(); for (const s of all.splice(0)) await s.stop(); });

describe("the wait between attempts", () => {
  it("doubles from 2 s up to 5 minutes, spread ±20 %", () => {
    expect([1, 2, 3, 4, 5].map((n) => retryDelay(n, () => 0.5))).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
    expect(retryDelay(30, () => 0.5)).toBe(RETRY_MAX_MS);
    expect(retryDelay(1, () => 0)).toBe(1_600);
    expect(retryDelay(1, () => 1)).toBe(2_400);
    expect(retryDelay(0, () => 0.5)).toBe(2_000);
  });
});

describe("a saved source at start-up", () => {
  it("slow: stays Connecting… with its last balance, without an error, until it answers", async () => {
    const server = new Server();
    const { s } = await saved(server);
    server.state = "slow";
    const connecting = s.ensureReady();
    await vi.waitFor(() => expect(server.attempts).toBe(2));
    expect(s.view).toMatchObject({ status: "connecting", balance: 1_234, unconfirmed: 5 });
    expect(s.view.balanceAt).toBeTypeOf("number");
    expect(s.view.error).toBeUndefined();
    server.answer();
    await connecting;
    expect(s.view.status).toBe("ready");
    // Read again: a fresh balance, no longer the remembered one.
    await vi.waitFor(() => expect(s.view.balanceAt).toBeUndefined());
    expect(s.view.balance).toBe(1_234);
  });

  it("down, then back up: Connecting… while it fails, Unavailable once sustained, connected by itself when it answers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const server = new Server();
    const { s, changed } = await saved(server);
    server.state = "down";
    await s.ensureReady();
    // One failure is not "Unavailable": it is tried again, and says why meanwhile.
    expect(s.view).toMatchObject({ status: "connecting", problem: "unreachable", failures: 1, balance: 1_234 });
    expect(s.view.error).toBe("Could not connect to Node: nothing answers at https://a.example");
    expect(s.view.retryAt).toBeGreaterThan(Date.now());
    // The retries run by themselves (20 ms, 40 ms…): still connecting while it has not failed for long.
    await vi.waitFor(() => expect(s.view.failures).toBeGreaterThanOrEqual(3));
    expect(s.view.status).toBe("connecting");
    // Failing for longer than SUSTAINED_MS: unavailable, and still tried again by itself.
    vi.setSystemTime(Date.now() + SUSTAINED_MS + 1_000);
    await vi.waitFor(() => expect(s.view.status).toBe("error"));
    expect(s.view.retryAt).toBeDefined();
    const before = server.attempts;
    await vi.waitFor(() => expect(server.attempts).toBeGreaterThan(before));
    // Back up: the next attempt connects, nothing to press.
    changed.mockClear();
    server.state = "up";
    await vi.waitFor(() => expect(s.view.status).toBe("ready"), { timeout: 2_000 });
    expect([s.view.failures, s.view.problem, s.view.error, s.view.retryAt]).toEqual([undefined, undefined, undefined, undefined]);
    expect(changed).toHaveBeenCalled();
    expect(s.active?.server).toBe("https://a.example");
  });

  it("a wrong setting is unavailable at once: waiting does not fix it", async () => {
    const server = new Server();
    const { s } = await saved(server);
    server.state = "wrong";
    await s.ensureReady();
    expect(s.view).toMatchObject({ status: "error", problem: "config", failures: 1 });
    expect(s.view.error).toContain("wrong network");
  });

  it("an error that says neither is treated as no answer (tried again, Connecting… first)", async () => {
    const server = new Server();
    const { s } = await saved(server);
    vi.spyOn(server, "connect").mockRejectedValueOnce(new Error("socket hang up"));
    await s.ensureReady();
    expect(s.view).toMatchObject({ status: "connecting", problem: "other", failures: 1 });
    await vi.waitFor(() => expect(s.view.status).toBe("ready"));
  });
});

describe("trying again now", () => {
  it("Retry skips the wait, and shows Connecting… again while it tries", async () => {
    const server = new Server();
    // A long wait: only Retry can make the next attempt happen in this test.
    const { s: again } = await saved(server, undefined, { backoff: 600_000 });
    server.state = "wrong";
    await again.ensureReady();
    expect(again.view.status).toBe("error");
    server.state = "slow";
    const retrying = again.retryNow();
    await vi.waitFor(() => expect(again.view.status).toBe("connecting"));
    server.answer();
    await retrying;
    expect(again.view.status).toBe("ready");
    // Connected: Retry does nothing more.
    const attempts = server.attempts;
    await again.retryNow();
    expect(server.attempts).toBe(attempts);
  });

  it("waking up (back online, back in front) tries a failing source at once, and reads a connected one's balance", async () => {
    const server = new Server();
    let balance = 1_234;
    const { s } = await saved(server, undefined, { balance: () => balance, backoff: 600_000 });
    server.state = "down";
    await s.ensureReady();
    expect(s.view.status).toBe("connecting");
    server.state = "up";
    s.wake();
    await vi.waitFor(() => expect(s.view.status).toBe("ready"));
    balance = 99;
    s.wake();
    await vi.waitFor(() => expect(s.view.balance).toBe(99));
  });
});

describe("the last balance read", () => {
  it("is kept per mode and source, and forgotten when another source is chosen or the source removed", async () => {
    const server = new Server();
    let unreadable = false;
    const { s } = await saved(server, undefined, { balance: () => { if (unreadable) throw new Error("no balance"); return 1_234; } });
    expect(s.view).toMatchObject({ status: "connecting", balance: 1_234 });
    // Another mode has its own (none here).
    await s.setMode("mainnet");
    expect(s.view.balance).toBeUndefined();
    await s.setMode("testnet");
    expect(s.view.balance).toBe(1_234);
    // The same provider, other settings (another wallet): not this one's balance, even before it reads its own.
    unreadable = true;
    await s.set("node", { server: "https://b.example", account: "2" });
    expect(s.view.balance).toBeUndefined();
    await s.stop();
    const { s: after } = sources(server, { balance: () => 7 });
    await after.start("testnet");
    expect(after.view.balance).toBeUndefined();
    await after.ensureReady();
    await vi.waitFor(() => expect(after.view.balance).toBe(7));
    await after.clear();
    expect(after.view.balance).toBeUndefined();
  });
});

describe("Change server", () => {
  it("keeps the secrets and the other settings, and connects to the new server before saving it", async () => {
    const server = new Server();
    const fields: ProviderDescriptor<Node>["fields"] = [{ name: "server", label: "Server", kind: "url", optional: true, changeable: true }, { name: "account", label: "Account", kind: "text" }, { name: "key", label: "Key", kind: "secret" }];
    const { s } = await saved(server, { server: "https://a.example", account: "main", key: "hunter22" }, { fields });
    server.state = "down";
    await s.ensureReady();
    expect(s.view.status).toBe("connecting");
    // The new server is down too: refused, nothing saved, the old one still tried.
    await expect(s.reconfigure({ server: "https://b.example" })).rejects.toThrow("Could not connect to Node: nothing answers at https://b.example");
    expect(s.view.config).toEqual({ server: "https://a.example", account: "main" });
    server.state = "up";
    // Only changeable fields change: the account is not touched by a value for it.
    await s.reconfigure({ server: "https://b.example", account: "other" });
    expect(s.view).toMatchObject({ status: "ready", config: { server: "https://b.example", account: "main" }, secrets: ["key"] });
    expect(s.active).toMatchObject({ server: "https://b.example", secret: "hunter22" });
    // The same wallet: its last balance is still its own.
    expect(s.view.balance).toBe(1_234);
    // Blank on an optional field: back to its default.
    await s.reconfigure({ server: "" });
    expect(s.view.config).toEqual({ account: "main" });
  }, 60_000); // Sealing a secret is a 600k-round PBKDF2, several times here.

  it("does not wait for an attempt that hangs: the attempt gives way", async () => {
    const server = new Server();
    const { s } = await saved(server);
    server.state = "slow";
    void s.ensureReady();
    await vi.waitFor(() => expect(server.attempts).toBe(2));
    server.state = "up";
    await s.reconfigure({ server: "https://b.example" });
    expect(s.active?.server).toBe("https://b.example");
    server.answer();
  });

  it("is refused without a saved source, or for a provider with no server to change", async () => {
    const server = new Server();
    const { s } = sources(server, { fields: [{ name: "server", label: "Server", kind: "url" }] });
    await s.start("testnet");
    await expect(s.reconfigure({ server: "https://b.example" })).rejects.toThrow("no saved source");
    await s.set("node", { server: "https://a.example" });
    await expect(s.reconfigure({ server: "https://b.example" })).rejects.toThrow("Node has no server to change");
  });

  it("is declared on a server address only: never a secret or a choice", () => {
    const d = (kind: "secret" | "select" | "url") => ({ ...descriptor(new Server()), fields: [{ name: "f", label: "F", kind, changeable: true, options: [{ value: "a", label: "A" }] }] }) as ProviderDescriptor<unknown>;
    expect(providerDescriptorProblems(d("secret"))).toContain("field f cannot be changeable: only a server address can");
    expect(providerDescriptorProblems(d("select"))).toContain("field f cannot be changeable: only a server address can");
    expect(providerDescriptorProblems(d("url"))).toEqual([]);
    const bad = { ...descriptor(new Server()), fields: [{ name: "f", label: "F", kind: "url", suggestions: [{ value: 1 }] }] } as unknown as ProviderDescriptor<unknown>;
    expect(providerDescriptorProblems(bad)).toContain("field f has malformed suggestions");
  });
});
