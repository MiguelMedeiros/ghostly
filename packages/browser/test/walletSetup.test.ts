import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_WALLETS, WalletSetup, type WalletSetupHost } from "../src/engine/walletSetup";
import { WALLET_SETUP_TEST_KEY, defaultWalletsAllowed } from "../src/platform/walletSetupSwitch";
import type { WalletOffer, WalletSetupRecord, WalletType } from "../src/shared/types";
// covers: wallet.instances.first-run

/** A profile's wallets as the setup sees them: offers per kind on Mainnet, creation that may fail, a stored record. */
function profile({ record, broken = [], unavailable = ["bitcoin"] }: { record?: WalletSetupRecord; broken?: WalletType[]; unavailable?: WalletType[] } = {}) {
  const state = { record, made: new Set<WalletType>(), broken: new Set(broken), saves: 0 };
  const host: WalletSetupHost = {
    record: () => state.record,
    save: async (next) => { state.record = next; state.saves++; },
    offer: async (type): Promise<WalletOffer> => ({ type, network: "mainnet", available: !unavailable.includes(type), exists: state.made.has(type), ...(type === "bitcoin" ? { needs: "provider" as const } : {}) }),
    create: vi.fn(async (type: WalletType) => {
      if (state.broken.has(type)) throw new Error(`Could not create the Mainnet ${type} wallet: the server did not answer. Nothing was saved; try again.`);
      state.made.add(type);
      await setup.made(type, "mainnet");
    }),
    changed: vi.fn(),
  };
  const setup = new WalletSetup(host);
  return { setup, host, state };
}

describe("a new profile's default Mainnet wallets", () => {
  it("a new profile gets Cashu and USDT on Mainnet, once; on-chain waits quietly while Mainnet has none", async () => {
    const { setup, host, state } = profile();
    await setup.begin(true);
    expect(host.create).toHaveBeenCalledTimes(2);
    expect([...state.made]).toEqual(["cashu", "usdt"]);
    expect(state.record).toEqual({ left: ["bitcoin"] });
    // Nothing to show: on-chain is not a failure.
    expect(setup.view()).toBeUndefined();
    // Next start: nothing is made again.
    await setup.begin(false);
    expect(host.create).toHaveBeenCalledTimes(2);
  });

  it("a wallet removed afterwards never comes back", async () => {
    const { setup, host, state } = profile();
    await setup.begin(true);
    state.made.delete("usdt"); // the person removed it
    await setup.begin(false);
    await setup.begin(true);
    expect(host.create).toHaveBeenCalledTimes(2);
    expect(state.made.has("usdt")).toBe(false);
  });

  it("an existing profile (no record, not new) is never set up, even with no wallet", async () => {
    const { setup, host, state } = profile();
    await setup.begin(false);
    expect(host.create).not.toHaveBeenCalled();
    expect(state.record).toBeUndefined();
  });

  it("the record is written before anything is tried, so a reload mid-setup does not start over as new", async () => {
    const { setup, host, state } = profile();
    (host.create as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { expect(state.record).toEqual({ left: [...DEFAULT_WALLETS] }); throw new Error("reload"); });
    await setup.begin(true);
    expect(state.record?.left).toContain("cashu");
  });

  it("a kind that fails keeps its reason for the Wallet page, is retried quietly at the next start, and on request", async () => {
    const { setup, host, state } = profile({ broken: ["usdt"] });
    await setup.begin(true);
    expect([...state.made]).toEqual(["cashu"]);
    expect(setup.view()).toEqual({ running: false, failed: [{ type: "usdt", network: "mainnet", reason: expect.stringContaining("did not answer") }] });
    // Next start, the server still down: tried once more, cashu not again.
    await setup.begin(false);
    expect((host.create as ReturnType<typeof vi.fn>).mock.calls.map(([type]) => type)).toEqual(["cashu", "usdt", "usdt"]);
    // Back up: Try again makes it, and the failure is gone.
    state.broken.clear();
    await setup.run("usdt");
    expect(state.made.has("usdt")).toBe(true);
    expect(state.record).toEqual({ left: ["bitcoin"] });
    expect(setup.view()).toBeUndefined();
  });

  it("while it runs the page hears so; a second run joins the first", async () => {
    const { setup, host } = profile();
    let release!: () => void;
    (host.create as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = setup.begin(true);
    await vi.waitFor(() => expect(setup.view()?.running).toBe(true));
    const second = setup.run();
    release();
    await Promise.all([first, second]);
    expect(host.create).toHaveBeenCalledTimes(2);
    expect(setup.view()).toBeUndefined();
  });

  it("a kind made by hand, or skipped, is not made by the setup", async () => {
    const { setup, host, state } = profile({ broken: ["cashu", "usdt"] });
    await setup.begin(true);
    await setup.made("cashu", "mainnet");
    await setup.made("usdt", "testnet"); // another network: still left
    await setup.dismiss("usdt");
    expect(state.record).toEqual({ left: ["bitcoin"] });
    state.broken.clear();
    await setup.begin(false);
    expect(host.create).toHaveBeenCalledTimes(2);
  });

  it("a kind already there (made in the meantime) is dropped without a second one", async () => {
    const { setup, host, state } = profile();
    state.made.add("cashu");
    await setup.begin(true);
    expect((host.create as ReturnType<typeof vi.fn>).mock.calls.map(([type]) => type)).toEqual(["usdt"]);
  });

  it("on-chain is made too once a Mainnet on-chain wallet is made in one click", async () => {
    const { setup, host, state } = profile({ unavailable: [] });
    host.offer = async (type) => ({ type, network: "mainnet", available: true, exists: state.made.has(type) });
    await setup.begin(true);
    expect([...state.made]).toEqual(["cashu", "usdt", "bitcoin"]);
    expect(state.record).toEqual({ left: [] });
  });
});

describe("where the setup runs", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const webdriver = (on: boolean) => vi.stubGlobal("navigator", { webdriver: on });

  it("in the apps, not in an automated browser or a test build; the test switch wins", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) });
    webdriver(false);
    expect(await defaultWalletsAllowed()()).toBe(true);
    expect(await defaultWalletsAllowed(() => true)()).toBe(false);
    expect(await defaultWalletsAllowed(async () => { throw new Error("no Tauri"); })()).toBe(false);
    webdriver(true);
    expect(await defaultWalletsAllowed()()).toBe(false);
    localStorage.setItem(WALLET_SETUP_TEST_KEY, "on");
    expect(await defaultWalletsAllowed(() => true)()).toBe(true);
    webdriver(false);
    localStorage.setItem(WALLET_SETUP_TEST_KEY, "off");
    expect(await defaultWalletsAllowed()()).toBe(false);
  });
});
