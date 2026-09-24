import { describe, expect, it } from "vitest";
import { chatPath, chatRouteSession } from "../../../src/lib/url";
// covers: calls.route-keep

/**
 * The app keeps a chat loaded by the session id in the address, so that a call
 * it holds survives a trip to Settings. Reading that id wrong loses the call.
 */
describe("chatRouteSession", () => {
  it("reads the session out of a chat address", () => {
    expect(chatRouteSession("/chat/abc123")).toBe("abc123");
    expect(chatRouteSession("/chat/abc123/")).toBe("abc123");
  });

  it("round-trips whatever chatPath writes", () => {
    for (const id of ["abc123", "a b", "a/b", "a%b", "ünïcøde"]) {
      expect(chatRouteSession(chatPath(id))).toBe(id);
    }
  });

  it("points at no chat anywhere else in the app", () => {
    for (const path of ["/", "/settings", "/wallet", "/share", "/chat", "/chat/"]) {
      expect(chatRouteSession(path)).toBeNull();
    }
  });

  it("points at no chat while the address still carries the keys", () => {
    // `ChatLinkIntake` stores these and replaces the address with `/chat/<id>`.
    expect(chatRouteSession("/chat/seed/peerpubkey/enckey")).toBeNull();
  });
});
