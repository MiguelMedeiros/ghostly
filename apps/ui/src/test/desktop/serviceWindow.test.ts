import { describe, expect, it } from "vitest";
import { GhostlyHttpError } from "@ghostly/core";
import { answerServiceWindow, type ServiceRequest } from "../../desktop/host";
import type { Language } from "../../lib/settings";
import { translatorFor } from "../../locales";

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

const LANGUAGES: Language[] = ["en", "pt", "es", "fr", "it", "zh", "ja", "ar"];

function contactFailing(error: unknown) {
  return {
    ready: Promise.resolve(),
    node: { request: async () => { throw error; } },
  } as unknown as Parameters<typeof answerServiceWindow>[0];
}

const page = (response: { body_b64: string }) => new TextDecoder().decode(Uint8Array.from(atob(response.body_b64), (c) => c.charCodeAt(0)));

describe("a Desktop viewer window's answer", () => {
  it("says a contact who is away in the profile's language", async () => {
    const said = new Set<string>();
    for (const language of LANGUAGES) {
      const t = translatorFor(language);
      const response = await answerServiceWindow(contactFailing(new GhostlyHttpError("unreachable", "Peer is not reachable")), request, t);
      expect(response.status).toBe(503);
      expect(page(response)).toBe(t("services.window.unreachable"));
      said.add(page(response));
    }
    expect(said.size).toBe(LANGUAGES.length);
  });

  it("says a request that failed in the profile's language, without the engine's own words", async () => {
    const said = new Set<string>();
    for (const language of LANGUAGES) {
      const t = translatorFor(language);
      const response = await answerServiceWindow(contactFailing(new Error("RTCDataChannel.send: InvalidStateError at link 7")), request, t);
      expect(response.status).toBe(502);
      expect(page(response)).toBe(t("services.window.failed"));
      expect(page(response)).not.toContain("InvalidStateError");
      said.add(page(response));
    }
    expect(said.size).toBe(LANGUAGES.length);
  });

  it("says an error the app knows in the profile's language", async () => {
    const t = translatorFor("pt");
    const response = await answerServiceWindow(contactFailing(new Error("Could not open the service")), request, t);
    expect(response.status).toBe(502);
    expect(page(response)).toBe(t("errors.extension.openService"));
  });

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
