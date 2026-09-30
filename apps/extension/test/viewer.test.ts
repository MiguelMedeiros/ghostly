import { describe, expect, it } from "vitest";
import { VIEWER_URL_PATTERN, parseViewerUrl, viewerUrl } from "../src/shared/viewer";
import { PEER } from "./extension";

// covers: services.open

describe("the viewer's virtual origin", () => {
  it("puts the peer key right under .invalid, so each peer is a site of its own", () => {
    expect(viewerUrl(PEER, "atlas")).toBe(`https://atlas.${PEER}.invalid/`);
    expect(viewerUrl(PEER, "atlas", "/a?b=c")).toBe(`https://atlas.${PEER}.invalid/a?b=c`);
    expect(VIEWER_URL_PATTERN).toBe("https://*.invalid/*");
  });

  it("reads back what it wrote, path and query included", () => {
    expect(parseViewerUrl(viewerUrl(PEER, "my-app-2", "/x/y?z=1#frag"))).toEqual({ peerPubKeyZ32: PEER, serviceId: "my-app-2", path: "/x/y?z=1" });
  });

  it.each([
    ["not a URL", "::"],
    ["plain http", `http://atlas.${PEER}.invalid/`],
    ["a port", `https://atlas.${PEER}.invalid:444/`],
    ["another suffix", `https://atlas.${PEER}.invalid.example/`],
    ["a deeper name", `https://x.atlas.${PEER}.invalid/`],
    ["no service", `https://${PEER}.invalid/`],
    ["a key with letters outside z-base-32", `https://atlas.${"l".repeat(52)}.invalid/`],
    ["a key of the wrong length", `https://atlas.${PEER}y.invalid/`],
    ["a service id starting with a dash", `https://-atlas.${PEER}.invalid/`],
    ["a service id too long", `https://${"a".repeat(33)}.${PEER}.invalid/`],
    ["a service id with an underscore", `https://at_las.${PEER}.invalid/`],
  ])("refuses %s", (_, url) => {
    expect(parseViewerUrl(url)).toBeNull();
  });
});
