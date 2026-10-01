import { describe, expect, it } from "vitest";
import { answerServiceWindow, type ServiceRequest } from "../../desktop/host";

// covers: services.desktop-viewer

/**
 * What a Desktop viewer window (a contact's shared app, apps/desktop/src/viewer.rs) is served for one request: the
 * main window asks the contact over the data link and hands the answer to Rust. The contact's app decides the
 * headers, so only real headers get through.
 */
const request: ServiceRequest = { id: 1, peer: "peer", service: "atlas", method: "GET", path: "/", headers: [], body_b64: null };

function contactAnswering(headers: [string, string][]) {
  return {
    ready: Promise.resolve(),
    node: {
      request: async () => ({ status: 200, headers, bytes: async () => new TextEncoder().encode("hi") }),
    },
  } as unknown as Parameters<typeof answerServiceWindow>[0];
}

describe("a Desktop viewer window's answer", () => {
  it("drops a header whose value carries CR, LF or NUL or whose name is no token, and keeps cookies on the window's origin", async () => {
    const response = await answerServiceWindow(
      contactAnswering([
        ["Content-Type", "text/html"],
        ["X-Note", "a\r\nSet-Cookie: sid=evil"],
        ["X-Line", "a\nb"],
        ["X-Nul", "a\u0000b"],
        ["Bad Name", "x"],
        ["Set-Cookie", "sid=1; Domain=peer; Path=/"],
      ]),
      request,
    );
    expect(response).toEqual({
      status: 200,
      headers: [
        ["Content-Type", "text/html"],
        ["Set-Cookie", "sid=1; Path=/"],
      ],
      body_b64: "aGk=",
    });
  });
});
