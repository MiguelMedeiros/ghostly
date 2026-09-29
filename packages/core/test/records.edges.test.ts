import { describe, expect, it } from "vitest";
import { encrypt, generateEncryptionKey } from "../src/crypto";
import { createIdentity } from "../src/identity";
import { MAX_DNS_PACKET_BYTES, measureRecords, type GhostRecord } from "../src/pkarr";
import { LABEL, MAX_MSGS_PAYLOAD_B64, RECORD_TTL, buildLinkRecords, parseLinkRecords } from "../src/records";

// covers: core.records

const id = createIdentity();
const key = generateEncryptionKey();
const parse = (records: GhostRecord[]) => parseLinkRecords({ pubKeyZ32: id.pubKeyZ32, timestampMicros: 1_500n, records }, key);
const rec = (label: string, value: string): GhostRecord => ({ label, value, ttl: RECORD_TTL });

describe("building link records", () => {
  it("publishes an empty batch and a zero timestamp when there are no messages", () => {
    const built = buildLinkRecords(id.pubKeyZ32, { messages: [], ackTimestamp: 0 }, key);
    expect(built.keptMessages).toBe(0);
    expect(built.servicesIncluded).toBe(false);
    const link = parse(built.records);
    expect(link.messages).toEqual([]);
    expect(link.latestTimestamp).toBe(0);
    expect(link.peerAck).toBe(0);
    expect(link.services).toBeNull();
  });

  it("cuts a single message too long for the batch to its first 400 characters", () => {
    const text = "abcdefghij".repeat(100);
    const built = buildLinkRecords(id.pubKeyZ32, { messages: [{ t: 3, m: text }], ackTimestamp: 0 }, key);
    expect(built.keptMessages).toBe(1);
    const [message] = parse(built.records).messages;
    expect(message.text).toBe(text.slice(0, 400));
    expect(built.records.find(r => r.label === LABEL.msgs)!.value.length).toBeLessThanOrEqual(MAX_MSGS_PAYLOAD_B64);
  });

  it("leaves the service advertisement out when signaling and services together do not fit", () => {
    const services = Array.from({ length: 12 }, (_, i) => ({ id: `svc-${i}`, type: "http", name: "N".repeat(40) }));
    const built = buildLinkRecords(id.pubKeyZ32, { messages: [{ t: 1, m: "hi" }], ackTimestamp: 1, rtcSignal: "r".repeat(300), services }, key);
    expect(built.servicesIncluded).toBe(false);
    expect(built.records.some(r => r.label === LABEL.svc)).toBe(false);
    expect(built.keptMessages).toBe(1);
    expect(measureRecords(id.pubKeyZ32, built.records)).toBeLessThanOrEqual(MAX_DNS_PACKET_BYTES);
  });

  it("refuses to build records whose signaling alone overflows the packet", () => {
    expect(() => buildLinkRecords(id.pubKeyZ32, { messages: [], ackTimestamp: 0, callSignal: "c".repeat(400), rtcSignal: "r".repeat(400) }, key))
      .toThrow("Link records do not fit in a Pkarr packet");
  });
});

describe("parsing link records from a peer", () => {
  it("ignores unknown labels, and reads non-numeric timestamps and acks as zero", () => {
    const link = parse([rec("_future", "x"), rec(LABEL.ts, "soon"), rec(LABEL.ack, "")]);
    expect(link.latestTimestamp).toBe(0);
    expect(link.peerAck).toBe(0);
    expect(link.rawRecordNames).toEqual(["_future", "_ts", "_ack"]);
  });

  it("takes the latest timestamp from the messages when _ts is missing", () => {
    const link = parse([rec(LABEL.msgs, encrypt(JSON.stringify([{ t: 5, m: "a" }, { t: 9, m: "b" }]), key))]);
    expect(link.latestTimestamp).toBe(9);
  });

  it("keeps the published _ts over the messages' own", () => {
    const link = parse([rec(LABEL.msgs, encrypt(JSON.stringify([{ t: 5, m: "a" }]), key)), rec(LABEL.ts, "7")]);
    expect(link.latestTimestamp).toBe(7);
  });

  it("drops batch entries that are not messages and keeps the rest", () => {
    const batch = [{ t: 1, m: "ok" }, { t: "2", m: "x" }, { t: 3 }, { m: "y" }, null, 7, "text", { t: 4, m: 5 }];
    const link = parse([rec(LABEL.msgs, encrypt(JSON.stringify(batch), key))]);
    expect(link.messages.map(m => m.text)).toEqual(["ok"]);
  });

  it("reads no messages from a batch that is not JSON or not an array", () => {
    for (const body of ["not json", JSON.stringify({ t: 1, m: "x" }), "7"]) {
      const link = parse([rec(LABEL.msgs, encrypt(body, key))]);
      expect(link.messages).toEqual([]);
      expect(link.latestTimestamp).toBe(0);
    }
  });

  it("reads nothing from values that do not decrypt, and records the payload length regardless", () => {
    const link = parse([rec(LABEL.msgs, "garbage"), rec(LABEL.nick, "garbage"), rec(LABEL.call, "x"), rec(LABEL.rtc, "x"), rec(LABEL.svc, "x")]);
    expect(link.messages).toEqual([]);
    expect(link.nick).toBeUndefined();
    expect(link.callSignal).toBeNull();
    expect(link.rtcSignal).toBeNull();
    expect(link.services).toBeNull();
    expect(link.encryptedPayloadLength).toBe(7);
  });

  it("strips hidden characters from the nickname and copies it onto every message", () => {
    const link = parse([rec(LABEL.nick, encrypt("\u202eEvil\u200b", key)), rec(LABEL.msgs, encrypt(JSON.stringify([{ t: 1, m: "a" }]), key))]);
    expect(link.nick).toBe("Evil");
    expect(link.messages[0].nick).toBe("Evil");
  });

  it("reads a services record that decrypts but is not an advertisement as none", () => {
    expect(parse([rec(LABEL.svc, encrypt("not json", key))]).services).toBeNull();
    expect(parse([rec(LABEL.svc, encrypt(JSON.stringify({ v: 1, s: [] }), key))]).services).toEqual([]);
  });

  it("converts the packet timestamp from microseconds to milliseconds", () => {
    expect(parse([]).packetTimestamp).toBe(1);
  });
});
