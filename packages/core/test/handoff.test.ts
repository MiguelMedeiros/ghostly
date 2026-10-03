import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  HANDOFF_ATTEMPTS, HANDOFF_LIST_PER_FRAME, HANDOFF_PIECE_BYTES, NO_ATTEMPTS, filePartDigest, filePartName, handoffAckFrame, handoffAttemptAllowed,
  handoffAttemptFailed, handoffAttemptSucceeded, handoffBusyFrame, handoffCancelFrame, handoffContext, handoffContextProof, handoffDataFrame,
  handoffDigest, handoffDoneFrame, handoffEphemeral, handoffFileMissingFrame, handoffFileRequestFrame, handoffHaveFrames, handoffHelloFrame,
  handoffManifestFrames, handoffOfferFrame, handoffPakeFrame, handoffReleaseFrame, handoffRequestFrame, handoffRetryAfter, handoffStreamKey,
  handoffVerifiedFrame, handoffVerifiedMessage, handoffVersions, isHandoffPartName, openHandoffPiece, readHandoffAck, readHandoffBusy,
  readHandoffCancel, readHandoffData, readHandoffDone, readHandoffFileFrame, readHandoffHave, readHandoffHello, readHandoffManifest, readHandoffPake,
  readHandoffRelease, readHandoffTurnFrame, readHandoffVerified, sealHandoffPiece, seedSigner, sortParts, toBase64Url, utf8Encode,
  deviceFrameCapability, HANDOFF_CAPABILITY, type HandoffHello, type HandoffPart,
} from "../src/index";
// covers: devices.handoff.frames

/*
 * `handoff/1` (WISP 06 § The handoff): its frames, `H`, the stream key, the sealed pieces, the version check and the
 * limits on wrong passwords. `vectors/handoff.json` is what this file builds from fixed labels, checked in: write it
 * again with `HANDOFF_VECTORS_WRITE=1 npx vitest run test/handoff.test.ts`. Every key here is a test value made from a label.
 */

const FILE = fileURLToPath(new URL("./vectors/handoff.json", import.meta.url));
const seed = (label: string) => sha256(utf8Encode(`ghostly handoff vectors: ${label}`));
const giver = seedSigner(seed("giver device"));
const taker = seedSigner(seed("taker device"));
const ADDRESS = seed("turn address");
const TRANSCRIPT = bytesToHex(seed("transcript"));
const digestOf = (label: string) => toBase64Url(seed(`file ${label}`));
const PARTS: HandoffPart[] = [
  [filePartName(digestOf("b")), 2_000_000, digestOf("b")],
  ["db/peer", 81_920, toBase64Url(seed("db"))],
  [filePartName(digestOf("a")), 17, digestOf("a")],
  ["local", 2_048, toBase64Url(seed("local"))],
];

interface Vectors {
  h: { turn: number; fromKey: string; toKey: string; parts: HandoffPart[]; json: string; h: string };
  verified: { message: string; frame: Record<string, unknown> };
  stream: { aSecret: string; bSecret: string; aPublic: string; bPublic: string; k: string; transcriptHash: string; streamKey: string; resumed: string };
  context: { context: string; proof: string };
  piece: { nonce: string; plain: string; sealed: string };
}

async function build(): Promise<Vectors> {
  const turn = 123_456_790;
  const h = handoffDigest(turn, giver.publicKey, taker.publicKey, PARTS);
  const a = handoffEphemeral(seed("a ephemeral")), b = handoffEphemeral(seed("b ephemeral"));
  const k = seed("pake key");
  const streamKey = handoffStreamKey(a.secret, b.publicKey, k, TRANSCRIPT);
  const resumed = handoffStreamKey(a.secret, b.publicKey, streamKey, bytesToHex(seed("second transcript")));
  const context = handoffContext(ADDRESS, giver.publicKey, taker.publicKey, TRANSCRIPT);
  const plain = utf8Encode("a piece of a part");
  return {
    h: {
      turn, fromKey: toBase64Url(giver.publicKey), toKey: toBase64Url(taker.publicKey), parts: PARTS,
      json: JSON.stringify(["ghostly-handoff/1", turn, toBase64Url(giver.publicKey), toBase64Url(taker.publicKey), sortParts(PARTS)]), h: toBase64Url(h),
    },
    verified: { message: new TextDecoder().decode(handoffVerifiedMessage(ADDRESS, turn, h)), frame: await handoffVerifiedFrame(ADDRESS, turn, h, taker) },
    stream: {
      aSecret: toBase64Url(a.secret), bSecret: toBase64Url(b.secret), aPublic: toBase64Url(a.publicKey), bPublic: toBase64Url(b.publicKey), k: toBase64Url(k),
      transcriptHash: TRANSCRIPT, streamKey: toBase64Url(streamKey), resumed: toBase64Url(resumed),
    },
    context: { context: bytesToHex(context), proof: toBase64Url(handoffContextProof(k, context)) },
    piece: { nonce: toBase64Url(seed("nonce").subarray(0, 24)), plain: toBase64Url(plain), sealed: toBase64Url(sealHandoffPiece(streamKey, plain, seed("nonce").subarray(0, 24))) },
  };
}

describe("handoff vectors", () => {
  it("match the checked-in file", async () => {
    const built = await build();
    if (process.env.HANDOFF_VECTORS_WRITE === "1" || !existsSync(FILE)) writeFileSync(FILE, `${JSON.stringify(built, null, 2)}\n`);
    expect(built).toEqual(JSON.parse(readFileSync(FILE, "utf8")) as Vectors);
  });

  it("H is the SHA-256 of the canonical JSON: parts sorted by name as bytes, base64url keys", async () => {
    const built = await build();
    expect(built.h.h).toBe(toBase64Url(sha256(utf8Encode(built.h.json))));
    expect(JSON.parse(built.h.json)[4].map((p: HandoffPart) => p[0])).toEqual(["db/peer", ...[digestOf("a"), digestOf("b")].sort().map(filePartName), "local"]);
  });

  it("H does not depend on the order parts are listed in, and changes with any part, the turn or a key", () => {
    const h = toBase64Url(handoffDigest(9, giver.publicKey, taker.publicKey, PARTS));
    expect(toBase64Url(handoffDigest(9, giver.publicKey, taker.publicKey, [...PARTS].reverse()))).toBe(h);
    expect(toBase64Url(handoffDigest(10, giver.publicKey, taker.publicKey, PARTS))).not.toBe(h);
    expect(toBase64Url(handoffDigest(9, taker.publicKey, giver.publicKey, PARTS))).not.toBe(h);
    expect(toBase64Url(handoffDigest(9, giver.publicKey, taker.publicKey, PARTS.slice(1)))).not.toBe(h);
    const changed = PARTS.map((p) => (p[0] === "local" ? ["local", p[1] + 1, p[2]] as HandoffPart : p));
    expect(toBase64Url(handoffDigest(9, giver.publicKey, taker.publicKey, changed))).not.toBe(h);
  });

  it("H refuses a part that is no part: a file whose name is not its digest, an unknown name, two parts of one name", () => {
    expect(() => handoffDigest(9, giver.publicKey, taker.publicKey, [[filePartName(digestOf("a")), 1, digestOf("b")]])).toThrow();
    expect(() => handoffDigest(9, giver.publicKey, taker.publicKey, [["../etc", 1, digestOf("a")]])).toThrow();
    expect(() => handoffDigest(9, giver.publicKey, taker.publicKey, [["local", 1, digestOf("a")], ["local", 2, digestOf("a")]])).toThrow("Two different parts");
    expect(() => handoffDigest(2 ** 32, giver.publicKey, taker.publicKey, [])).toThrow();
  });
});

describe("the stream key and the pieces", () => {
  it("is the same on both sides, differs for another session, another K or another key pair", () => {
    const a = handoffEphemeral(), b = handoffEphemeral(), k = seed("k");
    const ka = handoffStreamKey(a.secret, b.publicKey, k, TRANSCRIPT), kb = handoffStreamKey(b.secret, a.publicKey, k, TRANSCRIPT);
    expect(toBase64Url(ka)).toBe(toBase64Url(kb));
    expect(toBase64Url(handoffStreamKey(a.secret, b.publicKey, new Uint8Array(), TRANSCRIPT))).not.toBe(toBase64Url(ka));
    expect(toBase64Url(handoffStreamKey(a.secret, b.publicKey, k, bytesToHex(seed("other"))))).not.toBe(toBase64Url(ka));
    expect(toBase64Url(handoffStreamKey(handoffEphemeral().secret, b.publicKey, k, TRANSCRIPT))).not.toBe(toBase64Url(ka));
    expect(() => handoffStreamKey(a.secret, new Uint8Array(32), k, TRANSCRIPT)).toThrow("not a key");
    expect(() => handoffStreamKey(a.secret, b.publicKey, k, "AB")).toThrow();
  });

  it("a sealed piece opens under its key only, and not once changed", () => {
    const key = seed("key"), piece = seed("piece");
    const sealed = sealHandoffPiece(key, piece);
    expect(openHandoffPiece(key, sealed)).toEqual(piece);
    expect(openHandoffPiece(seed("other key"), sealed)).toBeNull();
    const changed = sealed.slice(); changed[30] ^= 1;
    expect(openHandoffPiece(key, changed)).toBeNull();
    expect(openHandoffPiece(key, sealed.subarray(0, 20))).toBeNull();
    // Two seals of one piece differ: a random nonce each.
    expect(toBase64Url(sealHandoffPiece(key, piece))).not.toBe(toBase64Url(sealed));
  });

  it("a whole piece, sealed, fits a device frame", () => {
    const frame = handoffDataFrame("db/peer", 0, sealHandoffPiece(seed("key"), new Uint8Array(HANDOFF_PIECE_BYTES)));
    expect(JSON.stringify(frame).length).toBeLessThan(60 * 1024);
    expect(readHandoffData(frame)?.sealed.length).toBe(HANDOFF_PIECE_BYTES + 40);
  });

  it("the context names the turn address, both keys and the session, and its proof is keyed by the password proof's key", () => {
    const context = handoffContext(ADDRESS, giver.publicKey, taker.publicKey, TRANSCRIPT);
    expect(context.length).toBe(17 + 32 * 4);
    const proof = toBase64Url(handoffContextProof(seed("k"), context));
    expect(toBase64Url(handoffContextProof(seed("k2"), context))).not.toBe(proof);
    expect(toBase64Url(handoffContextProof(seed("k"), handoffContext(ADDRESS, taker.publicKey, giver.publicKey, TRANSCRIPT)))).not.toBe(proof);
  });
});

describe("handoff frames", () => {
  const hello: HandoffHello = { v: 1, e: toBase64Url(handoffEphemeral(seed("e")).publicKey), app: "1.1.0", db: 12, pins: { ark: "0.4.76", bark: "0.25.0" }, kind: "web", room: 1_000_000, metered: false };

  it("travel under handoff/1", () => {
    for (const frame of [handoffHelloFrame(hello), handoffRequestFrame(1, "a".repeat(22)), handoffDataFrame("local", 0, new Uint8Array(40)), handoffAckFrame("local", 1), handoffDoneFrame(1)]) {
      expect(deviceFrameCapability(frame.t)).toBe(HANDOFF_CAPABILITY);
    }
  });

  it("hello reads back, and refuses what is not one", () => {
    expect(readHandoffHello(handoffHelloFrame(hello))).toEqual(hello);
    expect(readHandoffHello(handoffHelloFrame({ ...hello, later: 16 * 1024 * 1024, id: "b".repeat(22) }))).toMatchObject({ later: 16 * 1024 * 1024, id: "b".repeat(22) });
    // An unknown kind is read as web, as enrollment does.
    expect(readHandoffHello({ ...handoffHelloFrame(hello), kind: "toaster" })?.kind).toBe("web");
    for (const bad of [{ v: 2 }, { e: "short" }, { db: -1 }, { db: 1.5 }, { pins: { "Not A Type": "1" } }, { pins: { ark: "1 2" } }, { room: -2 }, { metered: "no" }, { id: "x" }, { app: "" }]) {
      expect(readHandoffHello({ ...handoffHelloFrame(hello), ...bad })).toBeNull();
    }
  });

  it("request, offer, busy, cancel, done and the file frames read back", () => {
    expect(readHandoffTurnFrame(handoffRequestFrame(7, "a".repeat(22)))).toEqual({ turn: 7, id: "a".repeat(22) });
    expect(readHandoffTurnFrame(handoffOfferFrame(7, "a".repeat(22), 500))).toEqual({ turn: 7, id: "a".repeat(22), bytes: 500 });
    expect(readHandoffTurnFrame({ t: "handoff-offer", turn: 7, id: "a".repeat(22) })).toBeNull();
    expect(readHandoffTurnFrame(handoffRequestFrame(2 ** 32, "a".repeat(22)))).toBeNull();
    expect(readHandoffBusy(handoffBusyFrame("locked-out", 3600))).toEqual({ why: "locked-out", retry: 3600 });
    expect(readHandoffBusy({ t: "handoff-busy", why: "bored", retry: 1 })).toBeNull();
    expect(readHandoffCancel(handoffCancelFrame("damaged"))).toBe("damaged");
    expect(readHandoffCancel({ t: "handoff-cancel", why: "something new" })).toBe("failed");
    expect(readHandoffDone(handoffDoneFrame(42))).toBe(42);
    expect(readHandoffFileFrame(handoffFileRequestFrame(digestOf("a")))).toEqual({ missing: false, sha256: digestOf("a") });
    expect(readHandoffFileFrame(handoffFileMissingFrame(digestOf("a")))).toEqual({ missing: true, sha256: digestOf("a") });
    expect(readHandoffFileFrame({ t: "handoff-file-request", sha256: "../x" })).toBeNull();
  });

  it("the three messages of the password proof read back; the third carries the context proof, or says the password was wrong", () => {
    expect(readHandoffPake(handoffPakeFrame({ n: 1, m: "AAAA" }))).toEqual({ n: 1, m: "AAAA" });
    expect(readHandoffPake(handoffPakeFrame({ n: 3, m: "AAAA", c: digestOf("c") }))).toEqual({ n: 3, m: "AAAA", c: digestOf("c") });
    expect(readHandoffPake(handoffPakeFrame({ n: 3, wrong: true }))).toEqual({ n: 3, wrong: true });
    expect(readHandoffPake({ t: "handoff-pake", n: 3, m: "AAAA" })).toBeNull();
    expect(readHandoffPake({ t: "handoff-pake", n: 1, wrong: true })).toBeNull();
    expect(readHandoffPake({ t: "handoff-pake", n: 4, m: "AAAA" })).toBeNull();
    expect(readHandoffPake({ t: "handoff-pake", n: 2, m: "A".repeat(5000) })).toBeNull();
  });

  it("have and manifest split into frames that fit, and read back to the same lists", () => {
    const digests = Array.from({ length: HANDOFF_LIST_PER_FRAME * 2 + 5 }, (_, i) => digestOf(`many ${i}`));
    const frames = handoffHaveFrames(digests, { [filePartName(digests[0])]: 65_536 });
    expect(frames.length).toBe(3);
    for (const frame of frames) expect(JSON.stringify(frame).length).toBeLessThan(60 * 1024);
    const read = frames.map((f) => readHandoffHave(f)!);
    expect(read.map((r) => r.more)).toEqual([true, true, false]);
    expect(read.flatMap((r) => r.d)).toEqual([...digests].sort());
    expect(read[2].p).toEqual({ [filePartName(digests[0])]: 65_536 });
    expect(handoffHaveFrames([]).map((f) => readHandoffHave(f))).toEqual([{ d: [], p: {}, more: false }]);

    const parts: HandoffPart[] = digests.map((d, i) => [filePartName(d), i, d]);
    const manifest = { pass: 1 as const, parts: parts.slice(0, 400), later: parts.slice(400), ids: Object.fromEntries(digests.map((d, i) => [d, [`chat-in-${i}`]])) };
    const mframes = handoffManifestFrames(manifest);
    for (const frame of mframes) expect(JSON.stringify(frame).length).toBeLessThan(60 * 1024);
    const back = mframes.map((f) => readHandoffManifest(f)!);
    expect(back.flatMap((m) => m.parts)).toEqual(sortParts(manifest.parts));
    expect(back.flatMap((m) => m.later)).toEqual(sortParts(manifest.later));
    expect(Object.assign({}, ...back.map((m) => m.ids))).toEqual(manifest.ids);
    expect(back.at(-1)!.more).toBe(false);
    expect(readHandoffManifest({ t: "handoff-manifest", pass: 3, parts: [] })).toBeNull();
    expect(readHandoffManifest({ t: "handoff-manifest", pass: 1, parts: [["file/x", 1, "x"]] })).toBeNull();
    expect(readHandoffManifest({ t: "handoff-manifest", pass: 1, parts: [], ids: { [digests[0]]: ["../../x"] } })).toBeNull();
  });

  it("data and ack read back, and a data frame with a piece too large is refused", () => {
    const sealed = sealHandoffPiece(seed("k"), new Uint8Array(10));
    expect(readHandoffData(handoffDataFrame("local", 65_536, sealed))).toEqual({ part: "local", offset: 65_536, sealed });
    expect(readHandoffData({ t: "handoff-data", p: "local", o: 0, d: toBase64Url(new Uint8Array(HANDOFF_PIECE_BYTES + 41)) })).toBeNull();
    expect(readHandoffData({ t: "handoff-data", p: "nope", o: 0, d: toBase64Url(sealed) })).toBeNull();
    expect(readHandoffAck(handoffAckFrame("local", 3))).toEqual({ part: "local", offset: 3 });
    expect(readHandoffAck({ t: "handoff-ack", p: "local", o: -1 })).toBeNull();
  });

  it("verified reads back only under the taker's key, for its turn address and turn", async () => {
    const h = seed("h");
    const frame = await handoffVerifiedFrame(ADDRESS, 10, h, taker);
    expect(readHandoffVerified(frame, ADDRESS, 10, taker.publicKey)).toEqual(h);
    expect(readHandoffVerified(frame, ADDRESS, 11, taker.publicKey)).toBeNull();
    expect(readHandoffVerified(frame, seed("other address"), 10, taker.publicKey)).toBeNull();
    expect(readHandoffVerified(frame, ADDRESS, 10, giver.publicKey)).toBeNull();
    expect(readHandoffVerified({ ...frame, h: digestOf("x") }, ADDRESS, 10, taker.publicKey)).toBeNull();
  });

  it("release reads back", () => {
    const release = { turn: 10, to: toBase64Url(taker.publicKey), h: digestOf("h"), s: toBase64Url(new Uint8Array(64)) };
    expect(readHandoffRelease(handoffReleaseFrame(release))).toEqual(release);
    expect(readHandoffRelease({ ...handoffReleaseFrame(release), s: "short" })).toBeNull();
  });

  it("part names are the WISP's, and a file part's name is its digest", () => {
    for (const name of ["db/peer", "db/settings", "local", "devices", filePartName(digestOf("a")), "wallet/ark/ghostly-ark-1"]) expect(isHandoffPartName(name)).toBe(true);
    for (const name of ["db/", "file/abc", "../local", "wallet/ARK/x", "Local", "db/a/b"]) expect(isHandoffPartName(name)).toBe(false);
    expect(filePartDigest(filePartName(digestOf("a")))).toBe(digestOf("a"));
    expect(filePartDigest("local")).toBeNull();
  });
});

describe("versions in the first frame", () => {
  const base = { app: "1.1.0", db: 12, pins: { ark: "0.4.76", bark: "0.25.0" } };
  it("a taker with an older database is refused; a newer one migrates, and the giver must update to take it back", () => {
    expect(handoffVersions(base, { ...base, db: 11 })).toEqual({ older: true, newerTaker: false, stayHome: [] });
    expect(handoffVersions(base, { ...base, db: 13 })).toEqual({ older: false, newerTaker: true, stayHome: [] });
    expect(handoffVersions(base, base)).toEqual({ older: false, newerTaker: false, stayHome: [] });
  });
  it("a wallet whose SDK pin differs, or that the taker lacks, stays home", () => {
    expect(handoffVersions(base, { ...base, pins: { ark: "0.4.77", bark: "0.25.0" } }).stayHome).toEqual(["ark"]);
    expect(handoffVersions(base, { ...base, pins: { ark: "0.4.76" } }).stayHome).toEqual(["bark"]);
    expect(handoffVersions({ ...base, pins: {} }, base).stayHome).toEqual([]);
  });
});

describe("wrong passwords", () => {
  const HOUR = HANDOFF_ATTEMPTS.hourMs;
  it("five in an hour lock the device out for an hour", () => {
    let attempts = NO_ATTEMPTS;
    for (let i = 0; i < 4; i++) { attempts = handoffAttemptFailed(attempts, 1_000 + i); expect(handoffAttemptAllowed(attempts, 1_000 + i)).toBe("ok"); }
    attempts = handoffAttemptFailed(attempts, 2_000);
    expect(handoffAttemptAllowed(attempts, 2_001)).toBe("locked-out");
    expect(handoffRetryAfter(attempts, 2_000)).toBe(3600);
    expect(handoffAttemptAllowed(attempts, 2_000 + HOUR)).toBe("ok");
  });

  it("failures spread over more than an hour do not lock out, and still count toward fifteen", () => {
    let attempts = NO_ATTEMPTS, now = 0;
    for (let i = 0; i < 14; i++) { attempts = handoffAttemptFailed(attempts, now); expect(handoffAttemptAllowed(attempts, now)).toBe("ok"); now += HOUR / 4 + 1; }
    attempts = handoffAttemptFailed(attempts, now);
    expect(attempts.total).toBe(15);
    expect(handoffAttemptAllowed(attempts, now + 365 * 24 * HOUR)).toBe("refused");
  });

  it("fifteen with locks between them: refused until the person lets it try again", () => {
    let attempts = NO_ATTEMPTS, now = 0;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 5; i++) attempts = handoffAttemptFailed(attempts, now + i);
      now += HOUR + 10;
    }
    expect(attempts.total).toBe(15);
    expect(handoffAttemptAllowed(attempts, now)).toBe("refused");
    expect(handoffAttemptAllowed(handoffAttemptSucceeded(), now)).toBe("ok");
  });

  it("a success starts the count again", () => {
    let attempts = NO_ATTEMPTS;
    for (let i = 0; i < 4; i++) attempts = handoffAttemptFailed(attempts, i);
    attempts = handoffAttemptSucceeded();
    for (let i = 0; i < 4; i++) attempts = handoffAttemptFailed(attempts, 10 + i);
    expect(handoffAttemptAllowed(attempts, 20)).toBe("ok");
    expect(attempts.total).toBe(4);
  });
});
