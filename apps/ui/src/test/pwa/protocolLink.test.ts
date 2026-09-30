import { describe, expect, it } from "vitest";
import { inviteRouteCode, protocolLinkCode } from "../../lib/url";

// covers: app.pwa.protocol

const CODE = "ghostly1pqqqqqqqqq";

describe("a web+ghostly: link in the address", () => {
  it("as the browser hands it over (escaped) or as written", () => {
    expect(protocolLinkCode(`/web%2Bghostly%3A${CODE}`)).toBe(CODE);
    expect(protocolLinkCode(`web%2Bghostly%3A${CODE}`)).toBe(CODE);
    expect(protocolLinkCode(`/web+ghostly:${CODE}`)).toBe(CODE);
    expect(protocolLinkCode(`/WEB+GHOSTLY:${CODE}`)).toBe(CODE);
    expect(protocolLinkCode(`/web%2Bghostly%3A%2F%2F${CODE}`)).toBe(CODE);
    expect(protocolLinkCode(`/web+ghostly://${CODE}`)).toBe(CODE);
  });

  it("is read as the invite it holds, like #ghostly1…", () => {
    expect(inviteRouteCode(`/web%2Bghostly%3A${CODE}`)).toBe(CODE);
    expect(inviteRouteCode(`/${CODE}`)).toBe(CODE);
  });

  it("holding something else, or nothing, is still taken (and refused) rather than left in the address", () => {
    expect(inviteRouteCode("/web%2Bghostly%3Anonsense")).toBe("nonsense");
    expect(inviteRouteCode("/web%2Bghostly%3A")).toBe("web+ghostly:");
    expect(protocolLinkCode("/web%2Bghostly%3A%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("other addresses are not links", () => {
    expect(protocolLinkCode("/")).toBeNull();
    expect(protocolLinkCode("/settings")).toBeNull();
    expect(protocolLinkCode("/chat/web+ghostly:x")).toBeNull();
    expect(protocolLinkCode("/web+nostr:npub1")).toBeNull();
  });
});
