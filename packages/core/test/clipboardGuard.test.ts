import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  allowingViewerGuard,
  CLIPBOARD_GUARD_HASH,
  CLIPBOARD_GUARD_SCRIPT,
  guardViewerAnswer,
  utf8Decode,
  utf8Encode,
  VIEWER_GUARD_CSP,
  VIEWER_GUARD_HASH,
  VIEWER_GUARD_SCRIPT,
  WEBRTC_GUARD,
} from "../src/index";

// covers: services.web-open

const CLIPBOARD = { script: CLIPBOARD_GUARD_SCRIPT, hash: CLIPBOARD_GUARD_HASH };

async function read(body: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of body) text += utf8Decode(chunk);
  return text;
}

describe("the clipboard guard of a contact's app on the web", () => {
  it("is allowed by its hash, and the srcdoc copy it makes of itself is the same text", () => {
    const hash = createHash("sha256").update(CLIPBOARD_GUARD_SCRIPT).digest("base64");
    expect(CLIPBOARD_GUARD_HASH).toBe(`'sha256-${hash}'`);
    const fn = CLIPBOARD_GUARD_SCRIPT.slice(1, CLIPBOARD_GUARD_SCRIPT.lastIndexOf(")("));
    expect(`(${fn})(window)`).toBe(CLIPBOARD_GUARD_SCRIPT);
    expect(CLIPBOARD_GUARD_SCRIPT.startsWith("(function noClipboardWrites(w) {")).toBe(true);
    // An HTML page reads it inline: nothing that would change on the way.
    expect(CLIPBOARD_GUARD_SCRIPT).not.toMatch(/[\\`]|\$\{|<\/script/i);
    // It finds the WebRTC guard's srcdoc copy by its start, when both run.
    expect(`<script>${VIEWER_GUARD_SCRIPT}`.startsWith("<script>(function noWebRtc(")).toBe(true);
    for (const name of ["execCommand", "paste", "eventPhase", "isTrusted", "contentWindow", "contentDocument", "getSVGDocument", "attachShadow", "setHTMLUnsafe", "parseHTMLUnsafe", "writeln", "shadowrootmode"]) expect(CLIPBOARD_GUARD_SCRIPT).toContain(name);
  });

  it("goes first in a page with the WebRTC guard after it, and the contact's policy takes both hashes", async () => {
    expect(allowingViewerGuard("script-src 'self'", [CLIPBOARD_GUARD_HASH, VIEWER_GUARD_HASH])).toBe(`script-src 'self' ${CLIPBOARD_GUARD_HASH} ${VIEWER_GUARD_HASH}`);
    const both = await guardViewerAnswer(
      [["content-type", "text/html"], ["content-security-policy", "default-src 'self'"]],
      (async function* () { yield utf8Encode("<!doctype html><p>hi"); })(),
      "iframe",
      [CLIPBOARD, WEBRTC_GUARD],
    );
    expect(await read(both.body)).toBe(`<!doctype html><script>${CLIPBOARD_GUARD_SCRIPT}</script><script>${VIEWER_GUARD_SCRIPT}</script><p>hi`);
    expect(both.headers.filter(([name]) => name === "content-security-policy").map(([, value]) => value))
      .toEqual([`default-src 'self' ${CLIPBOARD_GUARD_HASH} ${VIEWER_GUARD_HASH}`, VIEWER_GUARD_CSP]);
    const alone = await guardViewerAnswer([["content-type", "text/html"]], (async function* () { yield utf8Encode("<p>hi"); })(), "iframe", [CLIPBOARD]);
    expect(await read(alone.body)).toBe(`<script>${CLIPBOARD_GUARD_SCRIPT}</script><p>hi`);
  });
});

/**
 * The guard's rule, run in a DOM: a copy or a cut counts only while a trusted tap is being dispatched, a paste never.
 * Real taps and real clipboards are the e2e's (e2e/web/services-web-clipboard.spec.ts).
 */
describe("the clipboard guard's rule", () => {
  it("refuses a copy, a cut and a paste outside a tap, and passes every other command on", () => {
    const calls: string[] = [];
    class Doc { execCommand(command: string) { calls.push(command); return true; } }
    class Ev { get eventPhase() { return 0; } }
    const listeners: string[] = [];
    const w = {
      Reflect, Object, String, TypeError,
      Document: Doc,
      Event: Ev,
      EventTarget: { prototype: { addEventListener(type: string) { listeners.push(type); } } },
      Element: { prototype: {} },
      DocumentFragment: { prototype: {} },
      NodeList: { prototype: { get length() { return 0; } } },
      MutationObserver: class { observe() {} },
      get length() { return 0; },
      document: null as unknown,
    };
    Object.defineProperty(Doc.prototype, "defaultView", { get() { return w; } });
    w.document = new Doc();
    new Function("window", CLIPBOARD_GUARD_SCRIPT)(w);
    const doc = w.document as Doc;
    expect(doc.execCommand("copy")).toBe(false);
    expect(doc.execCommand("CUT")).toBe(false);
    expect(doc.execCommand("paste")).toBe(false);
    expect(doc.execCommand("bold")).toBe(true);
    expect(calls).toEqual(["bold"]);
    expect(listeners).toEqual(expect.arrayContaining(["pointerdown", "click", "keydown", "touchend"]));
    // Fixed in place, and the document it watches marked: the bridge reads both to know the guard ran in the page.
    const fixed = Object.getOwnPropertyDescriptor(Doc.prototype, "execCommand")!;
    expect([fixed.writable, fixed.configurable]).toEqual([false, false]);
    expect(Object.getOwnPropertyDescriptor(doc, "ghostlyClipboardGuard")).toMatchObject({ value: true, writable: false, configurable: false });
    // A window kept from its first, empty page (a same-origin page loaded in it): the new document is watched and
    // marked, and the window's guard is the one already there.
    listeners.length = 0;
    w.document = new Doc();
    new Function("window", CLIPBOARD_GUARD_SCRIPT)(w);
    expect(Object.getOwnPropertyDescriptor(w.document as object, "ghostlyClipboardGuard")?.value).toBe(true);
    expect(listeners).toEqual(["load"]);
    expect(Doc.prototype.execCommand).toBe(fixed.value);
  });
});
