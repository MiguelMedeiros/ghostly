import { describe, expect, it, vi } from "vitest";
import { createIdentity, STORAGE_ROOT } from "@ghostly/core";
import { readPubkyProof } from "../src/proofs/storage";
// covers: proofs.pubky

/**
 * The retired per-chat Pubky storage proof (proofs/storage.ts): reading a contact's proof file only at the
 * address Pubky itself resolves, bounded and timed, so a proof given before Pubky became an identity of the
 * profile (providers/pubky.ts) can still be read. Nothing writes one any more.
 */

const pubky = vi.hoisted(() => ({
  constructed: 0,
  freed: 0,
  get: undefined as unknown as (url: string) => Promise<Response>,
}));

vi.mock("@synonymdev/pubky", () => {
  class Pubky {
    constructor() { pubky.constructed++; }
    publicStorage = { get: (url: string) => pubky.get(url) };
    free() { pubky.freed++; }
  }
  return { Pubky };
});

const key = createIdentity().pubKeyZ32;
const path = `${STORAGE_ROOT}${"a".repeat(64)}/${"b".repeat(64)}.json`;
const body = (text: string | Uint8Array, headers: Record<string, string> = {}) => new Response(text as BodyInit, { headers });

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
