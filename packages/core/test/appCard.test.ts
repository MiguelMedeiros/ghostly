import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appCardId, checkStatusCard, readStatusCard, statusCardText, type AppCard } from "../src/index";
import { appKey, matchVectorFile } from "./appVectors";
import { readStatusCard as readStatusCard101 } from "./fixtures/statusCards-1.0.1";

// covers: apps.card

/*
 * The `app` card (WISP 405 § An app, WISP 1200 § Apps sent in a chat): a mini-app a person shared in a chat, or opened in
 * it, read from its own data. Pinned by `vectors/app-card.json`; write it again with `APPS_VECTORS_WRITE=1`.
 */

const FILE = fileURLToPath(new URL("./vectors/app-card.json", import.meta.url));
const PUBLISHER = appKey("publisher");
const REF = `${PUBLISHER}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const RAW = "https://raw.githubusercontent.com/ghostly-vectors/chess/HEAD/app.ghostlyapp";

const shared = { kind: "app", id: appCardId(REF), ref: REF, digest: DIGEST, sequence: 7, title: "Chess", version: "1.2.0", url: RAW };
const opened = { ...shared, opened: true };

interface Valid { name: string; card: Record<string, unknown>; reads: AppCard; text: string }
interface Invalid { name: string; refusal: "dropped"; card: Record<string, unknown> }

function build() {
  const valid: Valid[] = [];
  const invalid: Invalid[] = [];
  const yes = (name: string, card: Record<string, unknown>) => {
    const reads = readStatusCard(card) as AppCard;
    valid.push({ name, card, reads, text: statusCardText(reads) });
  };
  const no = (name: string, card: Record<string, unknown>) => invalid.push({ name, refusal: "dropped", card });
  const { url: _url, ...noUrl } = shared;
  const { version: _version, ...noVersion } = shared;

  yes("a shared card", shared);
  yes("an opened card", opened);
  yes("a shared card without url", noUrl);
  yes("an opened card without url", { ...noUrl, opened: true });
  yes("a card without version", noVersion);
  yes("sequence 0", { ...shared, sequence: 0 });
  yes("the largest sequence", { ...shared, sequence: Number.MAX_SAFE_INTEGER });
  yes("a url that is not https is left out", { ...shared, url: "http://raw.githubusercontent.com/ghostly-vectors/chess/HEAD/app.ghostlyapp" });
  yes("opened other than true reads as absent", { ...shared, opened: "yes" });
  yes("a title past 40 characters is cut", { ...shared, title: "C".repeat(50) });

  for (const field of ["id", "ref", "digest", "sequence", "title"] as const) {
    const { [field]: _gone, ...rest } = shared;
    no(`no ${field}`, rest);
  }
  no("a ref whose key is not 52 z-base32 characters", { ...shared, ref: `${PUBLISHER.slice(0, 51)}/chess`, id: `chess.${PUBLISHER.slice(0, 16)}` });
  no("a ref whose key has a letter outside z-base32", { ...shared, ref: `${PUBLISHER.slice(0, 51)}l/chess` });
  no("a ref whose name is not one", { ...shared, ref: `${PUBLISHER}/Chess` });
  no("an id that does not match the ref", { ...shared, id: `checkers.${PUBLISHER.slice(0, 16)}` });
  no("a digest that is not 43 base64url characters", { ...shared, digest: DIGEST.slice(1) });
  no("a sequence below 0", { ...shared, sequence: -1 });
  no("a sequence past 2^53 - 1", { ...shared, sequence: 2 ** 53 });
  no("a sequence that is not whole", { ...shared, sequence: 1.5 });
  no("an empty title", { ...shared, title: " " });
  return {
    about: {
      pins: "The app card of WISP 405 (§ An app) and its fallback text: what a reader keeps, and the cards it drops",
      wisp: "WISP 405, An app; WISP 1200, Apps sent in a chat and Test vectors",
      test: "packages/core/test/appCard.test.ts (APPS_VECTORS_WRITE=1 writes this file again)",
    },
    inputs: { keys: { publisher: { label: "publisher", key: PUBLISHER } } },
    valid,
    invalid,
  };
}

describe("app card vectors", () => {
  const file = matchVectorFile(FILE, build());

  it("reads every valid card as the file says, with its text", () => {
    for (const v of file.valid) {
      expect(readStatusCard(v.card), v.name).toEqual(v.reads);
      expect(statusCardText(v.reads), v.name).toBe(v.text);
    }
  });

  it("drops every invalid card, so the message shows its text", () => {
    for (const v of file.invalid) expect(readStatusCard(v.card), v.name).toBeUndefined();
  });
});

describe("the app card", () => {
  it("makes its id from the reference: the name, a dot, the first 16 characters of the key", () => {
    expect(appCardId(REF)).toBe(`chess.${PUBLISHER.slice(0, 16)}`);
  });

  it("writes a text an older app shows, the url on a line of its own", () => {
    expect(statusCardText(readStatusCard(opened)!)).toBe(`🧩 Opened Chess 1.2.0 in this chat (Ghostly app)\n${RAW}`);
    expect(statusCardText(readStatusCard(shared)!)).toBe(`🧩 Chess 1.2.0 (Ghostly app)\n${RAW}`);
    const { url: _url, ...noUrl } = shared;
    expect(statusCardText(readStatusCard(noUrl)!)).toBe("🧩 Chess 1.2.0 (Ghostly app)");
  });

  it("is no card to a reader without the app kind (Ghostly up to 1.1), which shows the text and its link", () => {
    expect(readStatusCard101(opened)).toBeUndefined();
    expect(statusCardText(readStatusCard(opened)!).split("\n")[1]).toBe(RAW);
  });

  it("is sent only as a reader would keep it", () => {
    expect(checkStatusCard(opened)).toEqual({ card: readStatusCard(opened) });
    expect(checkStatusCard({ ...shared, url: "http://example.com/app.ghostlyapp" })).toEqual({ error: expect.stringContaining("url") });
    expect(checkStatusCard({ ...shared, opened: false })).toEqual({ error: "opened is true or left out" });
    expect(checkStatusCard({ ...shared, title: "C".repeat(41) })).toEqual({ error: "title is at most 40 characters" });
    expect(checkStatusCard({ ...shared, version: "1".repeat(33) })).toEqual({ error: "version is at most 32 characters" });
    expect(checkStatusCard({ ...shared, id: "chess.other" })).toEqual({ error: `id is ${appCardId(REF)}, made from ref` });
    expect(checkStatusCard({ ...shared, links: [] })).toEqual({ error: "an app card takes no links" });
    expect(checkStatusCard({ ...shared, kind: "game" })).toEqual({ error: "kind is task, routine, buttons, app or usage" });
  });
});
