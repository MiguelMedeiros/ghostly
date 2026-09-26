import { describe, expect, it } from "vitest";
import { createChatInvite, encodeCommunityLink, encodeGroupEntryLink, inviteLink, randomBytes, toBase64Url, toZ32 } from "@ghostly/core";
import { neventEncode, noteEncode, nprofileEncode, npubEncode } from "nostr-tools/nip19";
import { entityKey, findEntities } from "../../lib/parse/entities";

// covers: chat.cards.invite, chat.cards.group, chat.cards.nostr, chat.cards.identity

const hex = () => Array.from(randomBytes(32), b => b.toString(16).padStart(2, "0")).join("");
const z32 = () => toZ32(randomBytes(32));
const groupId = () => toBase64Url(randomBytes(16));
/** One character of the checksum changed: the rest still looks right. */
const typo = (code: string) => code.slice(0, -1) + (code.endsWith("q") ? "p" : "q");
const kinds = (text: string) => findEntities(text).map(e => e.kind);
// The W3C DID spec's did:key example (an Ed25519 key).
const DID_KEY = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("findEntities: Ghostly invites", () => {
  const { inviteCode } = createChatInvite();

  it("finds a bare code and its link, inside a sentence, with where it is", () => {
    const text = `join me: ${inviteCode}, ok?`;
    const [e] = findEntities(text);
    expect(e).toMatchObject({ kind: "invite", code: inviteCode, start: 9, end: 9 + inviteCode.length });
    const link = `open ${inviteLink(inviteCode)}.`;
    expect(findEntities(link)).toMatchObject([{ kind: "invite", code: inviteCode, text: inviteLink(inviteCode) }]);
  });

  it("reads a code in capitals (a scanned QR) as the same invite", () => {
    expect(findEntities(inviteCode.toUpperCase())).toMatchObject([{ kind: "invite", code: inviteCode }]);
  });

  it("leaves a code with a wrong checksum as text", () => {
    expect(findEntities(`join ${typo(inviteCode)}`)).toEqual([]);
    expect(findEntities("ghostly1abc")).toEqual([]);
  });

  it("does not find a code glued to a word", () => {
    expect(findEntities(`x${inviteCode}`)).toEqual([]);
  });

  it("shows one card for the same invite written twice", () => {
    expect(findEntities(`${inviteCode} or ${inviteLink(inviteCode)}`)).toHaveLength(1);
  });
});

describe("findEntities: group links", () => {
  const g = groupId(), host = z32();

  it("finds a group's link and a community's, bare or in the app's address", () => {
    const entry = encodeGroupEntryLink({ g, host });
    expect(findEntities(`come in: ${entry}`)).toMatchObject([{ kind: "group", link: entry, community: false, groupId: g }]);
    const community = encodeCommunityLink({ g, host });
    expect(findEntities(`https://app.ghostly.tools/#/join/${community} (the hub)`)).toMatchObject([{ kind: "group", link: community, community: true, groupId: g }]);
  });

  it("refuses a link whose entry key is not a key", () => {
    expect(findEntities(`group1/${g}/${host.slice(0, -1)}l`)).toEqual([]); // "l" is not z-base-32
    expect(findEntities(`group1/${g.slice(1)}/${host}`)).toEqual([]);
  });
});

describe("findEntities: Nostr", () => {
  const pubkey = hex(), id = hex();

  it.each([
    ["npub", npubEncode(pubkey), { type: "profile", pubkey }],
    ["nprofile, relays as hints", nprofileEncode({ pubkey, relays: ["wss://relay.example"] }), { type: "profile", pubkey, relays: ["wss://relay.example"] }],
    ["note", noteEncode(id), { type: "note", id }],
    ["nevent with its author", neventEncode({ id, author: pubkey }), { type: "note", id, author: pubkey }],
  ])("finds an %s, bare or with nostr:", (_, code, pointer) => {
    expect(findEntities(`look ${code}!`)).toMatchObject([{ kind: "nostr", code, pointer }]);
    expect(findEntities(`look nostr:${code}.`)).toMatchObject([{ kind: "nostr", code, text: `nostr:${code}`, pointer }]);
  });

  it("leaves a wrong checksum, or a code of another kind, as text", () => {
    expect(findEntities(typo(npubEncode(pubkey)))).toEqual([]);
    expect(findEntities("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5")).toEqual([]);
  });

  it("keys a profile by its public key, however it was written", () => {
    const [a, b] = [findEntities(npubEncode(pubkey))[0], findEntities(nprofileEncode({ pubkey }))[0]];
    expect(entityKey(a)).toBe(entityKey(b));
    expect(findEntities(`${npubEncode(pubkey)} ${nprofileEncode({ pubkey })}`)).toHaveLength(1);
  });
});

describe("findEntities: identities", () => {
  it("finds a Pubky key as pubky:// or pk:", () => {
    const key = z32();
    expect(findEntities(`mine: pubky://${key}/pub/x`)).toMatchObject([{ kind: "identity", provider: "pubky", subject: key }]);
    expect(findEntities(`pk:${key.toUpperCase()}`)).toMatchObject([{ kind: "identity", provider: "pubky", subject: key }]);
  });

  it("does not take a bare 52-character string for a Pubky key", () => {
    expect(findEntities(z32())).toEqual([]);
  });

  it("finds each DID method Ghostly checks, the sentence's punctuation left out", () => {
    const dht = z32();
    expect(findEntities(`my DID is ${DID_KEY}.`)).toMatchObject([{ kind: "identity", provider: "did", subject: DID_KEY, text: DID_KEY }]);
    expect(findEntities(`did:dht:${dht}, and did:web:Example.com:`)).toMatchObject([
      { provider: "did", subject: `did:dht:${dht}` },
      { provider: "did", subject: "did:web:example.com", text: "did:web:Example.com" },
    ]);
  });

  it("leaves a DID that does not decode, or a method Ghostly does not check, as text", () => {
    expect(findEntities(`${DID_KEY.slice(0, -3)}zzz`)).toEqual([]);
    expect(findEntities("did:plc:ewvi7nxzyoun6zhxrhs64oiz")).toEqual([]);
    expect(findEntities("did:dht:tooshort")).toEqual([]);
  });
});

describe("findEntities: a message with several", () => {
  it("lists them in reading order", () => {
    const { inviteCode } = createChatInvite();
    expect(kinds(`${DID_KEY} then ${npubEncode(hex())} then ${inviteCode}`)).toEqual(["identity", "nostr", "invite"]);
  });

  it("finds nothing in ordinary text", () => {
    expect(findEntities("the ghostly1 thing, did: nothing, npub1 is short, pk: none")).toEqual([]);
  });
});
