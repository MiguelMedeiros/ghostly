import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  appRef, buildAppBundle, checkAppListing, checkAppManifest, checkAppRevokeStatement, checkAppStoreIndex, toBase64Url, type AppStoreIndex,
} from "../src/index";
import { APPS_NOW, DRAFT, ENTRY, appKey, appSigner } from "./appVectors";
// covers: apps.store

/*
 * An app's one-line texts (WISP 1200 - Manifest, Stores): a title, a tagline, a store's name, a removal's or a
 * revocation's reason. They are shown alone, as a heading or a window title, so none may hold a character that draws
 * nothing or turns the text around it, and one that must be there must show something.
 */

const REF = appRef(appKey("publisher"), "chess");
const DIGEST = toBase64Url(sha256(new Uint8Array([1])));
const manifest = { ghostlyApp: 1, publisher: appKey("publisher"), files: [{ path: ENTRY.path, size: ENTRY.bytes.length, sha256: toBase64Url(sha256(ENTRY.bytes)) }], ...DRAFT };
const listing = { ref: REF, sequence: 1, digest: DIGEST, urls: ["https://example.org/chess.ghostlyapp"], title: "Chess", tagline: "Play chess with a contact" };
const index: AppStoreIndex = {
  ghostlyStore: 1, key: appKey("store"), name: "Vector store", kind: "curated", sequence: 1, expires: APPS_NOW,
  apps: [listing], removed: [{ ref: REF, digest: DIGEST, reason: "Malware", at: APPS_NOW }], revoked: [],
};

/** The text of these code points: written by number, since most of them show nothing in the source. */
const cp = (...points: number[]) => String.fromCodePoint(...points);

/** A text with each kind of character refused, in the middle of a name or as all of it. */
const REFUSED: [string, (name: string) => string][] = [
  ["a right-to-left override", (t) => cp(0x202e) + t],
  ["a left-to-right isolate", (t) => cp(0x2066) + t],
  ["a right-to-left mark", (t) => t + cp(0x200f)],
  ["an Arabic letter mark", (t) => cp(0x061c) + t],
  ["a zero-width space", (t) => t.slice(0, 1) + cp(0x200b) + t.slice(1)],
  ["a word joiner", (t) => t + cp(0x2060)],
  ["a byte order mark", (t) => cp(0xfeff) + t],
  ["a soft hyphen", (t) => t.slice(0, 1) + cp(0xad) + t.slice(1)],
  ["a tag character", (t) => t + cp(0xe0041)],
  ["a line separator", (t) => t + cp(0x2028) + "x"],
  ["a paragraph separator", (t) => t + cp(0x2029) + "x"],
  ["a zero-width space alone", () => cp(0x200b)],
  ["a joiner alone", () => cp(0x200d)],
  ["a Hangul filler alone", () => cp(0x3164)],
  ["spaces alone", () => "   "],
];
/** Text a name may hold: the two joiners in an emoji or a script that needs them, and marks on a letter. */
const KEPT = [
  cp(0x1f469, 0x200d, 0x1f4bb) + " Code",
  cp(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645),
  cp(0x915, 0x94d, 0x200d, 0x937),
  "Cafe" + cp(0x301),
  "Xadrez " + cp(0x265f, 0xfe0f),
];

const reason = (r: { ok: true } | { ok: false; reason: string }) => (r.ok ? "accepted" : r.reason);

const FIELDS: [string, (text: string) => string][] = [
  ["a manifest's title", (t) => reason(checkAppManifest({ ...manifest, title: t }))],
  ["a manifest's tagline", (t) => reason(checkAppManifest({ ...manifest, tagline: t }))],
  ["a manifest's release notes", (t) => reason(checkAppManifest({ ...manifest, releaseNotes: t }))],
  ["a listing's title", (t) => reason(checkAppListing({ ...listing, title: t }))],
  ["a listing's tagline", (t) => reason(checkAppListing({ ...listing, tagline: t }))],
  ["a listing's developer", (t) => reason(checkAppListing({ ...listing, developer: t }))],
  ["a store's name", (t) => reason(checkAppStoreIndex({ ...index, name: t }))],
  ["a removal's reason", (t) => reason(checkAppStoreIndex({ ...index, removed: [{ ...index.removed[0]!, reason: t }] }))],
  ["a revocation's reason", (t) => (checkAppRevokeStatement({ ghostlyRevoke: 1, app: REF, upTo: 1, reason: t }) === null ? "accepted" : "bad-field")],
];

describe("an app's one-line texts", () => {
  for (const [field, check] of FIELDS) {
    it(`${field} refuses what draws nothing or turns the text`, () => {
      for (const [kind, make] of REFUSED) expect(check(make("Chess")), `${field}: ${kind}`).toBe("bad-field");
    });
    it(`${field} keeps the joiners and marks a script needs`, () => {
      for (const text of KEPT) expect(check(text), `${field}: ${text}`).toBe("accepted");
    });
  }

  it("a writer refuses them before anything is signed", async () => {
    await expect(buildAppBundle({ ...DRAFT, title: cp(0x202e) + "ssehC" }, [ENTRY], appSigner("publisher"))).rejects.toThrow(/title/);
  });
});
