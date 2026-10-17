import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/identity";
import { createChatInvite } from "../src/invite";
import { measureRecords } from "../src/pkarr";
import { createContactLink } from "../src/contactLink";
import {
  ContactRequestError, contactDay, knockHolds, knockSlotIdentity, knockSlotOf, knockSlotRecords, linkRecords, makeStamp, makeStampPaced, mergeContactKnocks,
  openRequest, readKnockSlot, readLinkRecord, requestPlaintextBytes, requestRecords, seenEntry, stampHolds,
  KNOCK_SLOTS, MAX_SEEN, MAX_SLOT_KNOCKS, REQUEST_LIFETIME_MS, REQUEST_PACKET_BYTES, type ContactKnock, type ContactRequest,
} from "../src/contactRecords";

const NOW = Date.UTC(2026, 9, 16, 12);
const TODAY = contactDay(NOW);
const link = createContactLink();
const asker = createIdentity();
const request = (over: Partial<ContactRequest> = {}): ContactRequest => ({
  invite: createChatInvite().inviteCode, name: "Kevin", text: "Hi, I found you on your site.", issued: NOW, expires: NOW + REQUEST_LIFETIME_MS, ...over,
});
const problem = (fn: () => unknown) => {
  try { fn(); return "none"; } catch (error) { return error instanceof ContactRequestError ? error.problem : String(error); }
};

describe("a contact link's request", () => {
  it("opens for the owner exactly as the asker wrote it", () => {
    const sent = request();
    expect(openRequest(link.seedB64, asker.pubKeyZ32, requestRecords(asker.seedB64, link.linkKeyZ32, sent), NOW)).toEqual(sent);
  });

  it("opens for nobody else: another link, another asker key, or a byte changed", () => {
    const records = requestRecords(asker.seedB64, link.linkKeyZ32, request());
    expect(openRequest(createContactLink().seedB64, asker.pubKeyZ32, records, NOW)).toBeNull();
    expect(openRequest(link.seedB64, createIdentity().pubKeyZ32, records, NOW)).toBeNull();
    const value = records[0].value;
    const tampered = [{ ...records[0], value: value.slice(0, 40) + (value[40] === "A" ? "B" : "A") + value.slice(41) }];
    expect(openRequest(link.seedB64, asker.pubKeyZ32, tampered, NOW)).toBeNull();
  });

  it("is one size whatever it says, and fits the packet with the longest name and text", () => {
    const short = requestRecords(asker.seedB64, link.linkKeyZ32, request({ name: "K", text: "hi" }));
    const long = requestRecords(asker.seedB64, link.linkKeyZ32, request({ name: "界".repeat(48), text: "€".repeat(66) }));
    expect(short[0].value.length).toBe(long[0].value.length);
    expect(measureRecords(asker.pubKeyZ32, long)).toBeLessThanOrEqual(REQUEST_PACKET_BYTES);
    expect(measureRecords(asker.pubKeyZ32, requestRecords(asker.seedB64, link.linkKeyZ32, request({ text: "x".repeat(200) })))).toBeLessThanOrEqual(1000);
    expect(requestPlaintextBytes()).toBeGreaterThanOrEqual(600);
  });

  it("refuses to send what breaks a bound, and says which", () => {
    const send = (over: Partial<ContactRequest>) => problem(() => requestRecords(asker.seedB64, link.linkKeyZ32, request(over)));
    expect(send({ name: "x".repeat(49) })).toBe("name");
    expect(send({ name: " Kevin" })).toBe("name");
    expect(send({ name: "Ke‮vin" })).toBe("name");
    expect(send({ name: "‍" })).toBe("name");
    expect(send({ text: "" })).toBe("text");
    expect(send({ text: "   " })).toBe("text");
    expect(send({ text: "é".repeat(101) })).toBe("text");
    expect(send({ invite: createContactLink().code })).toBe("invite");
    expect(send({ invite: "pair1/whatever" })).toBe("invite");
    expect(send({ expires: NOW })).toBe("dates");
    expect(send({ expires: NOW + REQUEST_LIFETIME_MS + 1 })).toBe("dates");
    // 200 bytes of quotes escape to 400: the packet has no room, and nothing is cut.
    expect(send({ text: "\"".repeat(200) })).toBe("too-long");
  });

  it("is not read when dated more than ten minutes ahead, so it cannot wait past its seven days", () => {
    const ahead = (ms: number) => requestRecords(asker.seedB64, link.linkKeyZ32, request({ issued: NOW + ms, expires: NOW + ms + REQUEST_LIFETIME_MS }));
    expect(openRequest(link.seedB64, asker.pubKeyZ32, ahead(10 * 60_000), NOW)).not.toBeNull();
    expect(openRequest(link.seedB64, asker.pubKeyZ32, ahead(10 * 60_000 + 1), NOW)).toBeNull();
  });

  it("is not read once it expired", () => {
    const records = requestRecords(asker.seedB64, link.linkKeyZ32, request({ expires: NOW + 60_000 }));
    expect(openRequest(link.seedB64, asker.pubKeyZ32, records, NOW + 59_999)).not.toBeNull();
    expect(openRequest(link.seedB64, asker.pubKeyZ32, records, NOW + 60_000)).toBeNull();
  });
});

describe("the stamp", () => {
  it("a made stamp holds for its bits, link, key and day, and for nothing else", () => {
    const stamp = makeStamp(link.linkKeyZ32, asker.pubKeyZ32, TODAY, 10);
    expect(stampHolds(link.linkKeyZ32, asker.pubKeyZ32, TODAY, stamp, 10)).toBe(true);
    expect(stampHolds(link.linkKeyZ32, asker.pubKeyZ32, TODAY + 1, stamp, 10)).toBe(false);
    expect(stampHolds(link.linkKeyZ32, createIdentity().pubKeyZ32, TODAY, stamp, 10)).toBe(false);
    expect(stampHolds(createContactLink().linkKeyZ32, asker.pubKeyZ32, TODAY, stamp, 10)).toBe(false);
    // The first stamp with 10 bits rarely has 20.
    const strong = makeStamp(link.linkKeyZ32, asker.pubKeyZ32, TODAY, 16);
    expect(stampHolds(link.linkKeyZ32, asker.pubKeyZ32, TODAY, strong, 16)).toBe(true);
    expect(stampHolds(link.linkKeyZ32, asker.pubKeyZ32, TODAY, stamp, 30)).toBe(false);
  });

  it("the paced stamp is the same stamp", async () => {
    expect(await makeStampPaced(link.linkKeyZ32, asker.pubKeyZ32, TODAY, 16)).toBe(makeStamp(link.linkKeyZ32, asker.pubKeyZ32, TODAY, 16));
  });

  it("the owner takes today's and yesterday's, not the day before nor tomorrow's", () => {
    const knock = (day: number): ContactKnock => ({ key: asker.pubKeyZ32, day, stamp: makeStamp(link.linkKeyZ32, asker.pubKeyZ32, day, 8) });
    expect(knockHolds(link.linkKeyZ32, knock(TODAY), 8, NOW)).toBe(true);
    expect(knockHolds(link.linkKeyZ32, knock(TODAY - 1), 8, NOW)).toBe(true);
    expect(knockHolds(link.linkKeyZ32, knock(TODAY - 2), 8, NOW)).toBe(false);
    expect(knockHolds(link.linkKeyZ32, knock(TODAY + 1), 8, NOW)).toBe(false);
  });
});

describe("the knock slots", () => {
  const knocks = (n: number, day = TODAY) => Array.from({ length: n }, () => ({ key: createIdentity().pubKeyZ32, day, stamp: 7 }));

  it("four keys every holder of the link derives, none of them the link key", () => {
    const keys = Array.from({ length: KNOCK_SLOTS }, (_, i) => knockSlotIdentity(link.linkKeyZ32, i).pubKeyZ32);
    expect(new Set(keys).size).toBe(KNOCK_SLOTS);
    expect(keys).not.toContain(link.linkKeyZ32);
    expect(knockSlotIdentity(link.linkKeyZ32, 2).pubKeyZ32).toBe(keys[2]);
    expect(() => knockSlotIdentity(link.linkKeyZ32, KNOCK_SLOTS)).toThrow();
    expect(knockSlotOf(link.linkKeyZ32, asker.pubKeyZ32)).toBe(knockSlotOf(link.linkKeyZ32, asker.pubKeyZ32));
    const used = new Set(Array.from({ length: 64 }, () => knockSlotOf(link.linkKeyZ32, createIdentity().pubKeyZ32)));
    expect(used.size).toBe(KNOCK_SLOTS);
  });

  it("a slot reads back with the link, holds six, and fits its packet", () => {
    const written = knocks(MAX_SLOT_KNOCKS + 2).map((k, i) => ({ ...k, stamp: 0xffffffff - i }));
    const records = knockSlotRecords(link.linkKeyZ32, written);
    expect(readKnockSlot(link.linkKeyZ32, records)).toEqual(written.slice(-MAX_SLOT_KNOCKS));
    expect(readKnockSlot(createContactLink().linkKeyZ32, records)).toEqual([]);
    expect(measureRecords(knockSlotIdentity(link.linkKeyZ32, 0).pubKeyZ32, records)).toBeLessThanOrEqual(1000);
  });

  it("a merge keeps others' fresh knocks, drops stale ones and my old one, and puts mine last", () => {
    const others = knocks(MAX_SLOT_KNOCKS);
    const stale = knocks(2, TODAY - 2);
    const mine = { key: asker.pubKeyZ32, day: TODAY, stamp: 1 };
    const merged = mergeContactKnocks([...stale, { ...mine, day: TODAY - 1 }, ...others], mine, NOW);
    expect(merged).toHaveLength(MAX_SLOT_KNOCKS);
    expect(merged.at(-1)).toEqual(mine);
    expect(merged.slice(0, -1)).toEqual(others.slice(-(MAX_SLOT_KNOCKS - 1)));
    expect(mergeContactKnocks([], mine, NOW)).toEqual([mine]);
  });
});

describe("the link record", () => {
  it("reads back, and its seen entries name no key", () => {
    const seen = Array.from({ length: MAX_SEEN + 3 }, () => seenEntry(link.linkKeyZ32, createIdentity().pubKeyZ32));
    const records = linkRecords({ state: "busy", bits: 20, seen });
    expect(readLinkRecord(records)).toEqual({ state: "busy", bits: 20, seen: seen.slice(0, MAX_SEEN) });
    expect(seenEntry(link.linkKeyZ32, asker.pubKeyZ32)).toHaveLength(12);
    expect(seenEntry(link.linkKeyZ32, asker.pubKeyZ32)).not.toBe(seenEntry(createContactLink().linkKeyZ32, asker.pubKeyZ32));
    expect(measureRecords(link.linkKeyZ32, records)).toBeLessThanOrEqual(1000);
  });

  it("refuses what is not one, and ignores what a later revision adds", () => {
    const read = (value: unknown) => readLinkRecord([{ label: "_cl", value: JSON.stringify(value) }]);
    expect(read([1, "off", 18, []])).toEqual({ state: "off", bits: 18, seen: [] });
    expect(read([1, "open", 18, [], "later"])).toEqual({ state: "open", bits: 18, seen: [] });
    expect(read([2, "open", 18, []])).toBeNull();
    expect(read([1, "closed", 18, []])).toBeNull();
    expect(read([1, "open", 25, []])).toBeNull();
    expect(read([1, "open", 18, ["short"]])).toBeNull();
    expect(readLinkRecord([{ label: "_cl", value: "{" }])).toBeNull();
    expect(() => linkRecords({ state: "open", bits: 12, seen: [] })).toThrow();
  });
});
