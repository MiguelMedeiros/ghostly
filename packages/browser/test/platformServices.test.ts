import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@ghostly/core";
import { setBrowserHost, type BrowserHost } from "../src/host";
import { fileStore } from "../src/shared/idb";
import { TEST_MINT } from "../src/shared/mints";
import type { EngineState, LinkView } from "../src/shared/types";
// covers: services.add, services.share, files.size-limit, wallet.cashu.mint.manage

/** What the shared UI calls, with the peer connection replaced by a recorder. */
const fake = vi.hoisted(() => ({
  engine: {
    state: null as unknown,
    calls: [] as [string, unknown][],
    answers: {} as Record<string, unknown>,
    subscribe: (_listener: () => void) => () => {},
    linkByPeer(peer: string) { return (fake.engine.state as { links: { peerPubKeyZ32: string }[] } | null)?.links.find((l) => l.peerPubKeyZ32 === peer); },
    async call(method: string, params?: unknown) {
      fake.engine.calls.push([method, params]);
      const answer = fake.engine.answers[method];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  },
}));
vi.mock("../src/platform/engine", () => ({ engine: fake.engine }));

const { servicesPlatform } = await import("../src/platform/services");
const services = servicesPlatform!;
const engine = fake.engine;

const chat = (over: Partial<LinkView> = {}) => ({ id: "link-1", peerPubKeyZ32: "peer-1", myPubKeyZ32: "me", deliveryMode: "stream", ...over }) as LinkView;
const withLinks = (...links: LinkView[]) => {
  engine.state = { links, settings: { online: true, relays: ["wss://r"], iceServers: [] }, transport: { protocol: "pkarr", relays: [] }, services: [], transfers: {}, payments: {}, wallet: { balance: 1 } } as unknown as EngineState;
};

let access: string[];
let host: BrowserHost;
beforeEach(() => {
  engine.state = null;
  engine.calls.length = 0;
  engine.answers = {};
  access = [];
  host = {
    version: "t", features: { shareLocalServices: true, openServices: true },
    connect: async () => ({ send: () => {} }),
    requestLocalAccess: async (pattern) => { access.push(pattern); return pattern.includes("127.0.0.1"); },
    openService: vi.fn(async () => {}),
  };
  setBrowserHost(host);
});

describe("sharing a local web app", () => {
  it("asks for access to the loopback origin before telling the peer about it", async () => {
    await services.shareService("Notes", "127.0.0.1:3400/app");
    expect(access).toEqual(["http://127.0.0.1/*"]);
    expect(engine.calls).toEqual([["addService", { name: "Notes", target: "127.0.0.1:3400/app" }]]);
  });

  it("shares nothing when the user does not grant access", async () => {
    await expect(services.shareService("Notes", "localhost:3400")).rejects.toThrow("needs your permission");
    expect(engine.calls).toEqual([]);
  });

  it("refuses a target off this machine before asking for any access", async () => {
    await expect(services.shareService("Bank", "https://bank.example")).rejects.toThrow("Only services on this machine");
    await expect(services.shareService("Creds", "http://user:pw@localhost:1")).rejects.toThrow("Credentials");
    expect(access).toEqual([]);
    expect(engine.calls).toEqual([]);
  });
});

describe("chat actions before the peer knows the chat", () => {
  it("refuses them instead of sending a call for a chat that does not exist", async () => {
    const attempts = [
      services.setChatPaymentMethods("peer-1", {} as never),
      services.setChatHold("peer-1", true),
      services.sendFile("peer-1", new Blob(["x"]) as File),
      services.wallet.checkPayment("peer-1", "p"),
      services.wallet.send("peer-1", 10),
      services.wallet.request("peer-1", 10),
      services.wallet.payRequest("peer-1", "p", {} as never),
      services.wallet.askToPay("peer-1", 10, "cashu" as never),
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toThrow("still starting");
    await services.deleteMessage("peer-1", "m");
    services.connect("peer-1");
    expect(services.getPeer("peer-1")).toBeNull();
    expect(engine.calls).toEqual([]);
  });

  it("addresses them to the chat's link once it exists", async () => {
    withLinks(chat());
    engine.answers = { sendPayment: { paymentId: "pay-1" }, requestPayment: { paymentId: "req-1" } };
    await services.setChatHold("peer-1", true);
    await services.deleteMessage("peer-1", "m1");
    const sent = await services.wallet.send("peer-1", 21, "coffee");
    const asked = await services.wallet.request("peer-1", 5, undefined, "lightning" as never);
    expect(sent.paymentId).toBe("pay-1");
    expect(asked.paymentId).toBe("req-1");
    expect(engine.calls.map(([m, p]) => [m, (p as { linkId: string }).linkId])).toEqual([
      ["setChatHold", "link-1"], ["deleteMessage", "link-1"], ["sendPayment", "link-1"], ["requestPayment", "link-1"],
    ]);
  });

  it("does not let a failed connection attempt escape", async () => {
    withLinks(chat());
    engine.answers = { connect: new Error("offline") };
    services.connect("peer-1");
    await Promise.resolve();
    expect(engine.calls).toEqual([["connect", { linkId: "link-1" }]]);
  });
});

describe("sending files", () => {
  it("refuses a file over the size limit without storing it", async () => {
    withLinks(chat({ id: "big" }));
    const huge = { name: "a.bin", size: LIMITS.maxFileBytes + 1, type: "" } as File;
    await expect(services.sendFile("peer-1", huge)).rejects.toThrow("too large");
    expect(await fileStore.listForLink("big")).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it("refuses a paired chat whose live peer cannot take files; one not live yet keeps it for when it is", async () => {
    withLinks(chat({ profile: "paired-chat/1", dataLink: "open", capabilities: { files: false, payments: true } }));
    await expect(services.sendFile("peer-1", new Blob(["x"]) as File)).rejects.toThrow("updated peer");
    expect(engine.calls).toEqual([]);
    withLinks(chat({ profile: "paired-chat/1", dataLink: "idle", capabilities: { files: false, payments: true } }));
    await services.sendFile("peer-1", new File(["x"], "x.txt"));
    expect(engine.calls.map(([method]) => method)).toEqual(["sendFile"]);
  });

  it("with files/3 a file is checked against the room the contact said it has; files/2 stops at 100 MB", () => {
    withLinks(chat({ profile: "paired-chat/1", dataLink: "open", capabilities: { files: true, payments: false, largeFiles: true }, peerFileRoom: 2 * 1024 ** 3 }));
    expect(services.fileTooLarge!("peer-1", 3 * 1024 ** 3)).toBe("Not enough space on your contact's device for this file (2.0 GB free).");
    expect(services.fileTooLarge!("peer-1", 1024 ** 3)).toBeNull();
    withLinks(chat({ profile: "paired-chat/1", dataLink: "open", capabilities: { files: true, payments: false } }));
    expect(services.fileTooLarge!("peer-1", LIMITS.maxFileBytes + 1)).toContain("updated Ghostly");
    withLinks(chat({ profile: "paired-chat/1", dataLink: "idle", capabilities: { files: false, payments: false } }));
    expect(services.fileTooLarge!("peer-1", 5 * 1024 ** 3), "not live: known when it goes").toBeNull();
  });

  it("stores the bytes under an id of its own and sends only a cleaned description of the file", async () => {
    withLinks(chat({ id: "files-link" }));
    const source = new File(["hello"], "../../.bashrc", { type: "Text/HTML; x" });
    const { file, timestamp } = await services.sendFile("peer-1", source);
    expect(file.id).toMatch(/^files-link-out-/);
    expect(file.name).toBe("bashrc");
    expect(file.mime).toBe("application/octet-stream");
    const [[method, params]] = engine.calls as [string, { file: object; linkId: string; timestamp: number }][];
    expect(method).toBe("sendFile");
    expect(params).toEqual({ linkId: "files-link", file, timestamp });
    const stored = await fileStore.get(file.id);
    expect(stored?.direction).toBe("out");
    expect(await stored?.blob.text()).toBe("hello");
    expect(stored?.transfer).toEqual({ state: "transferring", transferred: 0, size: 5 });
  });

  it("retries only a file this device sent, on a chat that still takes files", async () => {
    await fileStore.put({ id: "in-file", linkId: "link-1", blob: new Blob(["x"]), createdAt: 1, direction: "in", metadata: { name: "a", size: 1, mime: "text/plain", timestamp: 1 } });
    await fileStore.put({ id: "out-file", linkId: "link-1", blob: new Blob(["x"]), createdAt: 1, direction: "out", metadata: { name: "a", size: 1, mime: "text/plain", timestamp: 3 } });
    await expect(services.retryFile!("in-file")).rejects.toThrow("cannot be retried");
    await expect(services.retryFile!("missing")).rejects.toThrow("cannot be retried");
    await expect(services.retryFile!("out-file")).rejects.toThrow("updated peer");
    withLinks(chat({ profile: "paired-chat/1", capabilities: { files: false, payments: true } }));
    await expect(services.retryFile!("out-file")).rejects.toThrow("updated peer");
    expect(engine.calls).toEqual([]);

    withLinks(chat());
    await services.retryFile!("out-file");
    expect(engine.calls).toEqual([["sendFile", { linkId: "link-1", file: { id: "out-file", name: "a", size: 1, mime: "text/plain", timestamp: 3 }, timestamp: 3 }]]);
  });

  it("serves a received file as opaque bytes unless it is a previewable image", async () => {
    await fileStore.put({ id: "page", linkId: "l", blob: new Blob(["<script>"], { type: "text/html" }), createdAt: 1 });
    await fileStore.put({ id: "pic", linkId: "l", blob: new Blob(["png"], { type: "image/png" }), createdAt: 1 });
    expect((await services.getFile("page"))?.type).toBe("application/octet-stream");
    expect((await services.getFile("pic"))?.type).toBe("image/png");
    expect(await services.getFile("nothing")).toBeNull();
  });
});

describe("wallet and settings", () => {
  it("makes only the test mint primary when adding a mint", async () => {
    await services.wallet.addMint(TEST_MINT);
    await services.wallet.addMint("https://mint.example");
    expect(engine.calls).toEqual([
      ["walletAddMint", { url: TEST_MINT, primary: true }],
      ["walletAddMint", { url: "https://mint.example", primary: false }],
    ]);
  });

  it("unwraps the peer's answers to what the UI expects", async () => {
    engine.answers = { walletPayQuote: { paid: true }, walletReceiveToken: { amount: 42 }, walletInspectCashu: { inspection: { amount: 3 } } };
    expect(await services.wallet.payQuote("q", "m")).toBe(true);
    expect(await services.wallet.receiveToken("cashuB...")).toBe(42);
    expect(await services.wallet.inspectCashu("cashuB...")).toEqual({ amount: 3 });
  });

  it("finds the answer to an ask only among incoming requests", () => {
    withLinks();
    (engine.state as EngineState).payments = {
      mine: { ask: "ask-1", kind: "request", direction: "out" },
      paid: { ask: "ask-1", kind: "send", direction: "in" },
      theirs: { ask: "ask-1", kind: "request", direction: "in", id: "theirs" },
    } as never;
    expect(services.wallet.answerTo("ask-1")).toMatchObject({ id: "theirs" });
    expect(services.wallet.answerTo("ask-2")).toBeNull();
  });

  it("reads nothing before the first state, and the peer's view after", () => {
    expect(services.isOnline()).toBe(false);
    expect(services.getNetwork()).toBeNull();
    expect(services.wallet.getState()).toBeNull();
    expect(services.getSharedServices()).toEqual([]);
    expect(services.getTransfer("f")).toBeNull();
    expect(services.wallet.getPayment("p")).toBeNull();
    withLinks(chat({ peerOnline: true }));
    expect(services.isOnline()).toBe(true);
    expect(services.getNetwork()).toMatchObject({ protocol: "pkarr", relays: ["wss://r"], turn: null });
    expect(services.getPeer("peer-1")).toMatchObject({ id: "link-1", online: true });
  });

  it("drops a TURN server without an address when saving the network", async () => {
    await services.setNetwork({ relays: ["wss://a"], turn: { urls: "" } as never });
    await services.setNetwork({ relays: ["wss://a"], turn: { urls: "turn:t", username: "u", credential: "c" } });
    expect(engine.calls).toEqual([
      ["updateSettings", { settings: { relays: ["wss://a"], iceServers: [] } }],
      ["updateSettings", { settings: { relays: ["wss://a"], iceServers: [{ urls: "turn:t", username: "u", credential: "c" }] } }],
    ]);
  });

  it("leaves payment links to the page when the host cannot open them", async () => {
    expect(services.openPaymentLink("lightning:lnbc1")).toBeNull();
    const open = vi.fn(async () => {});
    setBrowserHost({ ...host, openPaymentLink: open, notice: "Heads up" });
    await services.openPaymentLink("bitcoin:bc1q");
    expect(open).toHaveBeenCalledWith("bitcoin:bc1q");
    expect(services.notice).toBe("Heads up");
    expect(services.features.openServices).toBe(true);
  });
});

describe("the RPC contract", () => {
  it("only ever calls methods the peer implements", async () => {
    const { GhostlyNode } = await import("../src/engine/node");
    withLinks(chat({ capabilities: { files: true, payments: true } }));
    engine.answers = { walletPayQuote: {}, walletReceiveToken: {}, walletInspectCashu: {}, sendPayment: {}, requestPayment: {} };
    const everything = { ...services, ...services.wallet } as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(everything)) {
      if (typeof value !== "function" || name === "subscribe") continue;
      const args = name === "shareService" ? ["Notes", "127.0.0.1:1"] : name === "sendFile" ? ["peer-1", new File(["x"], "x")] : ["peer-1", "x", "y"];
      try { await (value as (...a: unknown[]) => unknown)(...args); } catch { /* a refusal is fine here; the method name is what counts */ }
    }
    const called = [...new Set(engine.calls.map(([method]) => method))];
    expect(called.length).toBeGreaterThan(50);
    const missing = called.filter((method) => typeof (GhostlyNode.prototype as unknown as Record<string, unknown>)[method] !== "function");
    expect(missing).toEqual([]);
  });
});
