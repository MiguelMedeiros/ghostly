import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, STORAGE_ROOT, type ProofChallenge } from "@ghostly/core";
import { readPubkyProof, withPubkyStorage } from "../src/proofs/storage";
// covers: proofs.pubky

/**
 * The Pubky storage proof (proofs/storage.ts): reading a contact's proof file only at the address
 * Pubky itself resolves, bounded and timed; and writing one through the official Ring sign-in, where
 * a session secret never outlives the check, an approval arriving after a cancel is signed out, and
 * the temporary file is removed whatever happens.
 */

interface FakeSession {
  info: { publicKey: { z32(): string; free(): void }; capabilities: string[]; free(): void };
  storage: { putText: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  signout: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
}

const pubky = vi.hoisted(() => ({
  constructed: 0,
  freed: 0,
  get: undefined as unknown as (url: string) => Promise<Response>,
  capability: "",
  approval: undefined as unknown as { promise: Promise<unknown>; resolve(v: unknown): void; reject(e: unknown): void },
  flowFreed: 0,
}));

vi.mock("@synonymdev/pubky", () => {
  class Pubky {
    constructor() { pubky.constructed++; }
    publicStorage = { get: (url: string) => pubky.get(url) };
    startCookieAuthFlow(capability: string) {
      pubky.capability = capability;
      return { authorizationUrl: "pubkyauth:///?caps=test", awaitApproval: () => pubky.approval.promise, free: () => { pubky.flowFreed++; } };
    }
    free() { pubky.freed++; }
  }
  return { Pubky, AuthFlowKind: { signin: () => "signin" } };
});

const key = createIdentity().pubKeyZ32;
const path = `${STORAGE_ROOT}${"a".repeat(64)}/${"b".repeat(64)}.json`;
const body = (text: string | Uint8Array, headers: Record<string, string> = {}) => new Response(text as BodyInit, { headers });

function deferred() {
  let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function session(z32 = key, capabilities?: string[]): FakeSession & { freedParts: string[] } {
  const freedParts: string[] = [];
  return {
    freedParts,
    info: { publicKey: { z32: () => z32, free: () => { freedParts.push("key"); } }, get capabilities() { return capabilities ?? [pubky.capability]; }, free: () => { freedParts.push("info"); } },
    storage: { putText: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    signout: vi.fn(async () => {}),
    free: vi.fn(),
  };
}

const challenge = (externalKey: string): ProofChallenge => ({
  adapter: "pubky-storage", externalKey, subject: "s".repeat(52), audience: "a".repeat(52), context: "c".repeat(64), session: "e".repeat(64),
  nonce: "n".repeat(43), issuedAt: 1_800_000_000, expiresAt: 1_800_000_600,
});

function options(overrides: Partial<Parameters<typeof withPubkyStorage>[0]> = {}) {
  const controller = new AbortController();
  const links: string[] = [], progress: string[] = [];
  const opts = {
    signal: controller.signal,
    onLink: (url: string) => { links.push(url); },
    onProgress: (message: string) => { progress.push(message); },
    prepare: vi.fn(async (externalKey: string) => challenge(externalKey)),
    submit: vi.fn(async () => {}),
    ...overrides,
  };
  return { opts, controller, links, progress };
}

beforeEach(() => { pubky.approval = deferred(); pubky.flowFreed = 0; pubky.freed = 0; });
afterEach(() => { vi.useRealTimers(); });

describe("reading a contact's storage proof", () => {
  it("refuses an address that is not a Pubky key and a proof path, before any network", async () => {
    const constructed = pubky.constructed;
    await expect(readPubkyProof("not-a-key", path)).rejects.toThrow(/Invalid Pubky proof address/);
    await expect(readPubkyProof(key, "/pub/elsewhere/file.json")).rejects.toThrow(/Invalid Pubky proof address/);
    await expect(readPubkyProof(key, `${path}?redirect=https://evil`)).rejects.toThrow(/Invalid Pubky proof address/);
    expect(pubky.constructed).toBe(constructed);
  });

  it("reads through Pubky's own resolution of the key, with one shared public client", async () => {
    const asked: string[] = [];
    pubky.get = async (url) => { asked.push(url); return body('{"version":1}'); };
    expect(await readPubkyProof(key, path)).toBe('{"version":1}');
    expect(await readPubkyProof(key, path)).toBe('{"version":1}');
    expect(asked).toEqual([`pubky://${key}${path}`, `pubky://${key}${path}`]);
    expect(pubky.constructed).toBe(1);
  });

  it("refuses a file larger than a proof, or that is not text, or an error answer", async () => {
    pubky.get = async () => body("x".repeat(513));
    await expect(readPubkyProof(key, path)).rejects.toThrow(/too large/);
    pubky.get = async () => body("{}", { "content-length": "4096" });
    await expect(readPubkyProof(key, path)).rejects.toThrow(/unavailable/);
    pubky.get = async () => body(new Uint8Array([0xff, 0xfe, 0x00]));
    await expect(readPubkyProof(key, path)).rejects.toThrow();
    pubky.get = async () => new Response("gone", { status: 404 });
    await expect(readPubkyProof(key, path)).rejects.toThrow(/unavailable/);
  });

  it("gives up on a homeserver that does not answer within fifteen seconds", async () => {
    vi.useFakeTimers();
    pubky.get = () => new Promise(() => {});
    const reading = readPubkyProof(key, path);
    const result = expect(reading).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
  });
});

describe("writing a storage proof through Ring", () => {
  it("asks to write one fresh random folder, writes the proof there, and cleans up: file deleted, session signed out and freed", async () => {
    const s = session();
    const { opts, links, progress } = options();
    pubky.approval.resolve(s);
    await withPubkyStorage(opts);
    expect(pubky.capability).toMatch(new RegExp(`^${STORAGE_ROOT}[a-f0-9]{64}/:w$`));
    expect(links).toEqual(["pubkyauth:///?caps=test", "", ""]);
    expect(opts.prepare).toHaveBeenCalledWith(key);
    const [written, text] = s.storage.putText.mock.calls[0] as [string, string];
    expect(written.startsWith(pubky.capability.slice(0, -2))).toBe(true);
    expect(written).toMatch(/^\/pub\/ghostly\.app\/proofs\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/);
    // Only a commitment and an expiry are published: no key, no participant, no conversation.
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["commitment", "expiresAt", "version"]);
    expect(text).not.toContain(key);
    expect(opts.submit).toHaveBeenCalledWith(challenge(key), expect.objectContaining({ scheme: "pubky-storage/1" }));
    expect(s.storage.delete).toHaveBeenCalledWith(written);
    expect(s.signout).toHaveBeenCalledTimes(1);
    expect(s.free).toHaveBeenCalledTimes(1);
    expect(s.freedParts.sort()).toEqual(["info", "key"]);
    expect(progress.some((p) => /cleanup could not be confirmed/.test(p))).toBe(false);
    await vi.waitFor(() => expect([pubky.flowFreed, pubky.freed]).toEqual([1, 1]));
  });

  it("refuses a session with other folder permissions than asked, writes nothing and signs it out", async () => {
    const s = session(key, ["/pub/ghostly.app/:rw"]);
    const { opts } = options();
    pubky.approval.resolve(s);
    await expect(withPubkyStorage(opts)).rejects.toThrow(/different folder permissions/);
    expect(opts.prepare).not.toHaveBeenCalled();
    expect(s.storage.putText).not.toHaveBeenCalled();
    expect(s.storage.delete).not.toHaveBeenCalled();
    expect(s.signout).toHaveBeenCalled();
    expect(s.freedParts.sort()).toEqual(["info", "key"]);
  });

  it("cancelled while waiting: fails at once, and an approval arriving afterwards is signed out, never kept", async () => {
    const { opts, controller, links } = options();
    const run = withPubkyStorage(opts);
    const failed = expect(run).rejects.toThrow(/cancelled or timed out/);
    await vi.waitFor(() => expect(links).toContain("pubkyauth:///?caps=test"));
    controller.abort();
    await failed;
    const late = session();
    pubky.approval.resolve(late);
    await vi.waitFor(() => expect(late.signout).toHaveBeenCalled());
    expect(late.free).toHaveBeenCalled();
    expect(late.storage.putText).not.toHaveBeenCalled();
    expect(links.at(-1)).toBe("");
  });

  it("an approval that never comes times out after three minutes", async () => {
    vi.useFakeTimers();
    const { opts } = options();
    const failed = expect(withPubkyStorage(opts)).rejects.toThrow(/cancelled or timed out/);
    await vi.advanceTimersByTimeAsync(180_000);
    await failed;
  });

  it("an already cancelled signal stops before anything is asked", async () => {
    const controller = new AbortController();
    controller.abort();
    const { opts } = options({ signal: controller.signal });
    await expect(withPubkyStorage(opts)).rejects.toThrow();
    expect(opts.prepare).not.toHaveBeenCalled();
  });

  it("the contact's check failing still removes the file and signs out", async () => {
    const s = session();
    const { opts } = options({ submit: vi.fn(async () => { throw new Error("contact could not verify"); }) });
    pubky.approval.resolve(s);
    await expect(withPubkyStorage(opts)).rejects.toThrow(/contact could not verify/);
    expect(s.storage.delete).toHaveBeenCalled();
    expect(s.signout).toHaveBeenCalled();
    expect(s.free).toHaveBeenCalled();
  });

  it("says so when the cleanup cannot be confirmed", async () => {
    const s = session();
    s.storage.delete.mockRejectedValueOnce(new Error("homeserver down"));
    s.signout.mockRejectedValueOnce(new Error("homeserver down"));
    const { opts, progress } = options();
    pubky.approval.resolve(s);
    await withPubkyStorage(opts);
    expect(progress.at(-1)).toMatch(/cleanup could not be confirmed.*revoke the Ghostly folder session in Ring/);
    expect(s.free).toHaveBeenCalled();
  });
});
