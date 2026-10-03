import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";
import { handoffContext, randomBytes, toBase64Url } from "@ghostly/core";
import { HandoffPasswordError, isHandoffVerifier, makeHandoffVerifier, startPakeGiver, startPakeTaker } from "../src/devices/handoffPake";
// covers: devices.handoff.password

/*
 * The password proof of a pull (WISP 06 § Authorizing a handoff): OPAQUE through `@serenity-kit/opaque`, bound to the
 * turn address, both device signing keys and the session. Every password here is a test value.
 */

const PASSWORD = "a long lock password";
const giverKey = randomBytes(32), takerKey = randomBytes(32), address = randomBytes(32);
const context = (transcript = bytesToHex(randomBytes(32))) => handoffContext(address, giverKey, takerKey, transcript);

async function prove(verifier: Awaited<ReturnType<typeof makeHandoffVerifier>>, password: string, takerContext: Uint8Array, giverContext = takerContext) {
  const taker = await startPakeTaker(password);
  const giver = await startPakeGiver(verifier, taker.first);
  const third = await taker.finish(giver.second, takerContext);
  return { taker, giver, third, giverKey: await giver.finish(third.third, third.proof, giverContext) };
}

describe("the password proof of a pull", () => {
  it("with the right password both sides hold the same key, and every message is base64url that fits a frame", async () => {
    const verifier = await makeHandoffVerifier(PASSWORD);
    expect(isHandoffVerifier(verifier)).toBe(true);
    // The verifier holds no password.
    expect(JSON.stringify(verifier)).not.toContain(PASSWORD);
    const ctx = context();
    const taker = await startPakeTaker(PASSWORD);
    const giver = await startPakeGiver(verifier, taker.first);
    const third = await taker.finish(giver.second, ctx);
    const key = await giver.finish(third.third, third.proof, ctx);
    expect(toBase64Url(key)).toBe(toBase64Url(third.key));
    expect(key.length).toBe(64);
    for (const message of [taker.first, giver.second, third.third, third.proof]) {
      expect(message).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(message.length).toBeLessThan(4096);
    }
  });

  it("a wrong password fails on the taker, which never learns the key, and two runs give two keys", async () => {
    const verifier = await makeHandoffVerifier(PASSWORD);
    const taker = await startPakeTaker("not the password");
    const giver = await startPakeGiver(verifier, taker.first);
    await expect(taker.finish(giver.second, context())).rejects.toBeInstanceOf(HandoffPasswordError);
    const ctx = context();
    const one = await prove(verifier, PASSWORD, ctx), two = await prove(verifier, PASSWORD, ctx);
    expect(toBase64Url(one.giverKey)).not.toBe(toBase64Url(two.giverKey));
  });

  it("a proof made in another session or for other keys does not hold", async () => {
    const verifier = await makeHandoffVerifier(PASSWORD);
    await expect(prove(verifier, PASSWORD, context(), context())).rejects.toBeInstanceOf(HandoffPasswordError);
    const transcript = bytesToHex(randomBytes(32));
    const swapped = handoffContext(address, takerKey, giverKey, transcript);
    await expect(prove(verifier, PASSWORD, handoffContext(address, giverKey, takerKey, transcript), swapped)).rejects.toBeInstanceOf(HandoffPasswordError);
  });

  it("a replayed third message is refused: on the same second message, and in a new run", async () => {
    const verifier = await makeHandoffVerifier(PASSWORD);
    const ctx = context();
    const run = await prove(verifier, PASSWORD, ctx);
    await expect(run.giver.finish(run.third.third, run.third.proof, ctx)).rejects.toBeInstanceOf(HandoffPasswordError);
    // A new run of the giver, sent the third message of the old one.
    const taker = await startPakeTaker(PASSWORD);
    const giver = await startPakeGiver(verifier, taker.first);
    await expect(giver.finish(run.third.third, run.third.proof, ctx)).rejects.toBeInstanceOf(HandoffPasswordError);
  });

  it("a changed third message or proof is refused, and so is a first message that is no message", async () => {
    const verifier = await makeHandoffVerifier(PASSWORD);
    const ctx = context();
    const taker = await startPakeTaker(PASSWORD);
    const giver = await startPakeGiver(verifier, taker.first);
    const third = await taker.finish(giver.second, ctx);
    await expect(giver.finish(`${third.third.slice(0, -4)}AAAA`, third.proof, ctx)).rejects.toBeInstanceOf(HandoffPasswordError);
    const again = await startPakeGiver(verifier, taker.first);
    await expect(again.finish(third.third, toBase64Url(randomBytes(32)), ctx)).rejects.toBeInstanceOf(HandoffPasswordError);
    await expect(startPakeGiver(verifier, "AAAA")).rejects.toBeInstanceOf(HandoffPasswordError);
  });

  it("a verifier for another password, or no verifier, proves nothing", async () => {
    const other = await makeHandoffVerifier("another long password");
    await expect(prove(other, PASSWORD, context())).rejects.toBeInstanceOf(HandoffPasswordError);
    await expect(startPakeGiver({ v: 1, setup: "", record: "" } as never, "AAAA")).rejects.toThrow("no password proof");
    expect(isHandoffVerifier({ v: 2, setup: "a", record: "b" })).toBe(false);
  });
});
