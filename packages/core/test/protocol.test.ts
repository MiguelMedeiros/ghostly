import { describe, expect, it } from "vitest";
import {
  LABEL,
  MAX_DNS_PACKET_BYTES,
  PacketTooLargeError,
  buildLinkRecords,
  createIdentity,
  createLink,
  createRelayPayload,
  decodeInviteCode,
  decodeServices,
  decodeTxtPacket,
  decrypt,
  encodeInviteCode,
  encodeServices,
  encodeTxtPacket,
  encrypt,
  fromBase64,
  fromBase64Url,
  fromZ32,
  generateEncryptionKey,
  identityFromSeedB64,
  measureRecords,
  parseLinkRecords,
  parseRelayPayload,
  serviceIdFromName,
  toZ32,
  type ServiceAd,
} from "../src";
import { RUST_FIXTURE } from "./fixtures";

describe("identity", () => {
  it("derives the same z-base-32 address as the Rust client", () => {
    expect(identityFromSeedB64(RUST_FIXTURE.seedB64).pubKeyZ32).toBe(RUST_FIXTURE.pubKeyZ32);
  });

  it("round-trips z-base-32", () => {
    const id = createIdentity();
    expect(id.pubKeyZ32).toHaveLength(52);
    expect(fromZ32(id.pubKeyZ32)).toEqual(id.publicKey);
    expect(toZ32(fromZ32(RUST_FIXTURE.pubKeyZ32))).toBe(RUST_FIXTURE.pubKeyZ32);
  });
});

describe("crypto", () => {
  it("round-trips and rejects the wrong key", () => {
    const key = generateEncryptionKey();
    const box = encrypt("boo 👻", key);
    expect(decrypt(box, key)).toBe("boo 👻");
    expect(() => decrypt(box, generateEncryptionKey())).toThrow();
  });
});

describe("pkarr packets", () => {
  it("verifies and decrypts a packet published by the Rust implementation", () => {
    const packet = parseRelayPayload(RUST_FIXTURE.pubKeyZ32, fromBase64(RUST_FIXTURE.relayPayloadB64));
    expect(packet.records.map((r) => r.label)).toEqual([LABEL.msgs, LABEL.ts]);

    const link = parseLinkRecords(packet, fromBase64Url(RUST_FIXTURE.encKeyB64));
    expect(link.messages).toHaveLength(1);
    expect(link.messages[0].text).toMatch(/^hello from rust/);
    expect(link.latestTimestamp).toBe(link.messages[0].timestamp);
    expect(link.services).toBeNull();
  });

  it("rejects a tampered packet", () => {
    const payload = fromBase64(RUST_FIXTURE.relayPayloadB64);
    payload[payload.length - 1] ^= 1;
    expect(() => parseRelayPayload(RUST_FIXTURE.pubKeyZ32, payload)).toThrow("Invalid signature");
  });

  it("rejects a packet signed by someone else", () => {
    const payload = createRelayPayload(createIdentity(), [{ label: "_ts", value: "1" }]);
    expect(() => parseRelayPayload(createIdentity().pubKeyZ32, payload)).toThrow("Invalid signature");
  });

  it("signs packets that verify, and refuses oversized ones", () => {
    const id = createIdentity();
    const payload = createRelayPayload(id, [{ label: "_ts", value: "42" }], 1234n);
    const packet = parseRelayPayload(id.pubKeyZ32, payload);
    expect(packet.timestampMicros).toBe(1234n);
    expect(packet.records).toEqual([{ label: "_ts", value: "42", ttl: 300 }]);
    expect(() => createRelayPayload(id, [{ label: "_big", value: "x".repeat(1200) }])).toThrow(PacketTooLargeError);
  });
});

describe("dns codec", () => {
  it("compresses the shared origin and splits long TXT values", () => {
    const origin = createIdentity().pubKeyZ32;
    const records = [
      { name: `_msgs.${origin}`, value: "a".repeat(600), ttl: 300 },
      { name: `_ts.${origin}`, value: "1", ttl: 300 },
      { name: `_svc.${origin}`, value: "", ttl: 300 },
    ];
    const encoded = encodeTxtPacket(records);
    expect(decodeTxtPacket(encoded)).toEqual(records);
    // the 52 character origin must be written only once
    expect(encoded.length).toBeLessThan(600 + 3 + 12 + 3 * 20 + 60);
  });

  it("survives malformed input", () => {
    expect(() => decodeTxtPacket(new Uint8Array(4))).toThrow();
    const loop = new Uint8Array([0, 0, 0x80, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 12]);
    expect(() => decodeTxtPacket(loop)).toThrow();
  });
});

describe("invites", () => {
  it("uses the desktop invite format", () => {
    const { mine, invite } = createLink();
    expect(decodeInviteCode(encodeInviteCode(invite))).toEqual(invite);
    expect(decodeInviteCode(`https://ghostly.tools/#/chat/${encodeInviteCode(invite)}`)).toEqual(invite);
    expect(identityFromSeedB64(mine.seedB64).pubKeyZ32).toBe(invite.peerPubKeyZ32);
    expect(decodeInviteCode("nope")).toBeNull();
  });
});

describe("services", () => {
  const services: ServiceAd[] = [
    { id: "chat", type: "chat" },
    { id: "voice", type: "voice" },
    { id: "atlas", type: "http", name: "Atlas", proto: "ghostly-http/1" },
  ];

  it("round-trips compactly", () => {
    const wire = encodeServices(services);
    expect(wire).toBe('{"v":1,"s":["chat","voice",{"i":"atlas","t":"http","n":"Atlas","p":"ghostly-http/1"}]}');
    expect(decodeServices(wire)).toEqual(services);
  });

  it("drops invalid entries instead of trusting them", () => {
    const wire = JSON.stringify({
      v: 1,
      s: ["chat", "chat", "http://localhost:22", { i: "../etc", t: "http" }, { i: "ok", t: "http", n: "a\nb" }, 7],
    });
    expect(decodeServices(wire)).toEqual([
      { id: "chat", type: "chat" },
      { id: "ok", type: "http", name: "ab" },
    ]);
    expect(decodeServices("[]")).toBeNull();
    expect(decodeServices("{")).toBeNull();
  });

  it("derives ids from names", () => {
    expect(serviceIdFromName("Atlas")).toBe("atlas");
    expect(serviceIdFromName("My App!", ["my-app"])).toBe("my-app-2");
    expect(serviceIdFromName("chat")).toBe("chat-2");
    expect(serviceIdFromName("👻")).toBe("service");
  });
});

describe("link records", () => {
  const id = createIdentity();
  const key = generateEncryptionKey();
  const parse = (records: ReturnType<typeof buildLinkRecords>["records"]) =>
    parseLinkRecords({ pubKeyZ32: id.pubKeyZ32, timestampMicros: 5_000_000n, records }, key);

  it("round-trips everything a link publishes", () => {
    const built = buildLinkRecords(
      id.pubKeyZ32,
      {
        messages: [
          { t: 2, m: "second" },
          { t: 1, m: "first" },
        ],
        ackTimestamp: 9,
        nick: "Casper",
        callSignal: '{"t":"h","ts":1}',
        rtcSignal: '{"t":"o"}',
        services: [{ id: "atlas", type: "http", name: "Atlas" }],
      },
      key,
    );
    const link = parse(built.records);
    expect(link.messages.map((m) => m.text)).toEqual(["first", "second"]);
    expect(link.messages[0].nick).toBe("Casper");
    expect(link.latestTimestamp).toBe(2);
    expect(link.peerAck).toBe(9);
    expect(link.callSignal).toBe('{"t":"h","ts":1}');
    expect(link.rtcSignal).toBe('{"t":"o"}');
    expect(link.services).toEqual([{ id: "atlas", type: "http", name: "Atlas" }]);
    expect(link.packetTimestamp).toBe(5000);
  });

  it("looks like a legacy packet when nothing new is set", () => {
    const built = buildLinkRecords(id.pubKeyZ32, { messages: [{ t: 1, m: "hi" }], ackTimestamp: 0 }, key);
    expect(built.records.map((r) => r.label)).toEqual([LABEL.msgs, LABEL.ts]);
  });

  it("keeps signaling and drops the oldest messages when the packet is full", () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({ t: i + 1, m: `message ${i} ${"x".repeat(80)}` }));
    const built = buildLinkRecords(
      id.pubKeyZ32,
      {
        messages,
        ackTimestamp: 1,
        nick: "Casper",
        rtcSignal: "r".repeat(260),
        services: [{ id: "atlas", type: "http", name: "Atlas" }],
      },
      key,
    );
    expect(measureRecords(id.pubKeyZ32, built.records)).toBeLessThanOrEqual(MAX_DNS_PACKET_BYTES);
    expect(built.keptMessages).toBeGreaterThan(0);
    expect(built.keptMessages).toBeLessThan(messages.length);

    const link = parse(built.records);
    expect(link.rtcSignal).toBe("r".repeat(260));
    expect(link.services).toHaveLength(1);
    expect(link.messages.at(-1)?.timestamp).toBe(12);
    expect(link.latestTimestamp).toBe(12);
  });

  it("ignores records encrypted with another key", () => {
    const built = buildLinkRecords(
      id.pubKeyZ32,
      { messages: [{ t: 1, m: "secret" }], ackTimestamp: 0, services: [] },
      generateEncryptionKey(),
    );
    const link = parse(built.records);
    expect(link.messages).toEqual([]);
    expect(link.services).toBeNull();
  });
});

describe("asking to pay", () => {
  it("round-trips a pay-ask and a request answering it, and refuses what is not one", async () => {
    const { encodeControl, decodeControl } = await import("../src/frames");
    const ask = { t: "pay-ask", id: "ask_123456", ts: 1, v: "1000", u: "sat", m: "arkade", memo: "lunch" } as const;
    expect(decodeControl(encodeControl(ask))).toEqual(ask);
    const req = decodeControl(JSON.stringify({ t: "pay-req", id: "req_123456", ts: 2, v: "1000", u: "sat", e: [["arkade", "{}"]], a: "ask_123456" }));
    expect(req).toMatchObject({ t: "pay-req", a: "ask_123456" });
    expect(decodeControl(JSON.stringify({ t: "pay-req", id: "req_123456", ts: 2, v: "1000", u: "sat", e: [["arkade", "{}"]], a: "<script>" }))).toMatchObject({ a: undefined });
    for (const bad of [{ ...ask, m: "cashu" }, { ...ask, m: "lightning" }, { ...ask, v: "-1" }, { ...ask, v: "1e9" }, { ...ask, id: "x" }, { ...ask, u: "SAT!" }, { ...ask, ts: "1" }])
      expect(decodeControl(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
    expect((decodeControl(JSON.stringify({ ...ask, memo: "m".repeat(500) })) as { memo: string }).memo).toHaveLength(140);
  });
});
