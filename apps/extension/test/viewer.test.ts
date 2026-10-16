import { describe, expect, it } from "vitest";
import { VIEWER_URL_PATTERN, parseViewerUrl, viewerUrl } from "../src/shared/viewer";
import { PEER, TAG } from "./extension";

// covers: services.open

describe("the viewer's virtual origin", () => {
  it("puts the chat's tag right under .invalid, so each chat with a peer is a site of its own", () => {
    expect(viewerUrl(PEER, "atlas", TAG)).toBe(`https://atlas.${PEER}.${TAG}.invalid/`);
    expect(viewerUrl(PEER, "atlas", TAG, "/a?b=c")).toBe(`https://atlas.${PEER}.${TAG}.invalid/a?b=c`);
    expect(VIEWER_URL_PATTERN).toBe("https://*.invalid/*");
  });

  it("reads back what it wrote, path and query included", () => {
    expect(parseViewerUrl(viewerUrl(PEER, "my-app-2", TAG, "/x/y?z=1#frag"))).toEqual({ peerPubKeyZ32: PEER, serviceId: "my-app-2", tag: TAG, path: "/x/y?z=1" });
  });

  it.each([
    ["not a URL", "::"],
    ["plain http", `http://atlas.${PEER}.${TAG}.invalid/`],
    ["a port", `https://atlas.${PEER}.${TAG}.invalid:444/`],
    ["another suffix", `https://atlas.${PEER}.${TAG}.invalid.example/`],
    ["a deeper name", `https://x.atlas.${PEER}.${TAG}.invalid/`],
    ["no service", `https://${PEER}.${TAG}.invalid/`],
    ["no chat tag", `https://atlas.${PEER}.invalid/`],
    ["a chat tag of the wrong length", `https://atlas.${PEER}.${TAG}y.invalid/`],
    ["a chat tag with letters outside z-base-32", `https://atlas.${PEER}.${"l".repeat(16)}.invalid/`],
    ["a key with letters outside z-base-32", `https://atlas.${"l".repeat(52)}.${TAG}.invalid/`],
    ["a key of the wrong length", `https://atlas.${PEER}y.${TAG}.invalid/`],
    // The same 32 bytes as PEER: `o` and `t` differ in a padding bit alone, and only `o` is the key (WISP 02).
    ["a key respelled in its last character", `https://atlas.${PEER.slice(0, 51)}t.${TAG}.invalid/`],
    ["a service id starting with a dash", `https://-atlas.${PEER}.${TAG}.invalid/`],
    ["a service id too long", `https://${"a".repeat(33)}.${PEER}.${TAG}.invalid/`],
    ["a service id with an underscore", `https://at_las.${PEER}.${TAG}.invalid/`],
  ])("refuses %s", (_, url) => {
    expect(parseViewerUrl(url)).toBeNull();
  });
});
