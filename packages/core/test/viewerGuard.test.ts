import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  allowingViewerGuard,
  guardViewerAnswer,
  utf8Decode,
  utf8Encode,
  viewerGuardOffset,
  VIEWER_GUARD_CSP,
  VIEWER_GUARD_HASH,
  VIEWER_GUARD_SCRIPT,
  type HeaderList,
} from "../src/index";

const TAG = `<script>${VIEWER_GUARD_SCRIPT}</script>`;

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  for (const part of parts) yield utf8Encode(part);
}

async function read(body: AsyncIterable<Uint8Array>): Promise<string> {
  let text = "";
  for await (const chunk of body) text += utf8Decode(chunk);
  return text;
}

const policies = (headers: HeaderList) => headers.filter(([name]) => name.toLowerCase() === "content-security-policy").map(([, value]) => value);

describe("the WebRTC guard of a contact's app (Hide my IP from contacts)", () => {
  it("is allowed by its hash, and the srcdoc copy it makes of itself is the same text", () => {
    const hash = createHash("sha256").update(VIEWER_GUARD_SCRIPT).digest("base64");
    expect(VIEWER_GUARD_HASH).toBe(`'sha256-${hash}'`);
    // `"(" + noWebRtc + ")(window)"` in the page: the function's own source between the parentheses.
    const fn = VIEWER_GUARD_SCRIPT.slice(1, VIEWER_GUARD_SCRIPT.lastIndexOf(")("));
    expect(`(${fn})(window)`).toBe(VIEWER_GUARD_SCRIPT);
    expect(VIEWER_GUARD_SCRIPT.startsWith("(function noWebRtc(w) {")).toBe(true);
    // Desktop keeps a raw copy, and an HTML page reads it inline: nothing that would change on the way.
    expect(VIEWER_GUARD_SCRIPT).not.toMatch(/[\\`]|\$\{|<\/script/i);
    // What a frame element hands out is guarded first, and the shadow trees the page makes are watched for `srcdoc`.
    for (const name of ["contentWindow", "contentDocument", "getSVGDocument", "attachShadow", "HTMLObjectElement", "setHTMLUnsafe", "parseHTMLUnsafe", "writeln", "shadowrootmode"]) expect(VIEWER_GUARD_SCRIPT).toContain(name);
    expect(VIEWER_GUARD_CSP).toBe("frame-src 'self'; object-src 'self'; require-trusted-types-for 'script'");
  });

  it("gives a contact's policy the guard's hash only where the policy would refuse it", () => {
    // covers: settings.network.relay-only
    expect(allowingViewerGuard("img-src *")).toBe("img-src *");
    expect(allowingViewerGuard("default-src 'self' 'unsafe-inline'")).toBe("default-src 'self' 'unsafe-inline'");
    expect(allowingViewerGuard("script-src 'nonce-abc'")).toBe(`script-src 'nonce-abc' ${VIEWER_GUARD_HASH}`);
    expect(allowingViewerGuard("default-src 'self'; img-src *")).toBe(`default-src 'self' ${VIEWER_GUARD_HASH}; img-src *`);
    // A nonce turns 'unsafe-inline' off: the hash is needed.
    expect(allowingViewerGuard("script-src 'unsafe-inline' 'nonce-x'")).toBe(`script-src 'unsafe-inline' 'nonce-x' ${VIEWER_GUARD_HASH}`);
    expect(allowingViewerGuard("script-src 'unsafe-inline' 'strict-dynamic'")).toBe(`script-src 'unsafe-inline' 'strict-dynamic' ${VIEWER_GUARD_HASH}`);
    // The directive that governs `<script>` elements, the first of its name.
    expect(allowingViewerGuard("default-src 'none'; script-src-elem 'self'; script-src 'unsafe-inline'")).toBe(`default-src 'none'; script-src-elem 'self' ${VIEWER_GUARD_HASH}; script-src 'unsafe-inline'`);
    expect(allowingViewerGuard("script-src 'none', default-src 'unsafe-inline'")).toBe(`script-src 'none' ${VIEWER_GUARD_HASH}, default-src 'unsafe-inline'`);
  });

  it("goes after the byte order mark, blank space, comments and the doctype, and waits for them to end", () => {
    const at = (text: string, done = true) => viewerGuardOffset(Uint8Array.from(text, (c) => c.charCodeAt(0)), done);
    expect(at("<!doctype html><title>x</title>")).toBe(15);
    expect(at("ï»¿  <!DOCTYPE html>\n<html>")).toBe(20);
    expect(at("<!-- a --><!--> <?xml x?><!doctype html><p>")).toBe(40);
    expect(at("<html><script>")).toBe(0);
    expect(at("  <p>")).toBe(2);
    expect(at("<!-- not done", false)).toBeNull();
    expect(at("<!doc", false)).toBeNull();
    expect(at("<", false)).toBeNull();
    expect(at("", false)).toBeNull();
    // At the end of the page (or past the look), before what never ended.
    expect(at("<!-- not done")).toBe(0);
    expect(at("<!doctype html><!-- a")).toBe(15);
  });

  it("puts itself first in an HTML page, and adds its policy", async () => {
    const { headers, body } = await guardViewerAnswer(
      [["content-type", "text/html; charset=utf-8"], ["content-length", "40"], ["content-security-policy", "script-src 'nonce-a'"]],
      chunks("<!doc", "type html><title>Atlas</title><script nonce=a>go()</script>"),
      "iframe",
    );
    expect(await read(body)).toBe(`<!doctype html>${TAG}<title>Atlas</title><script nonce=a>go()</script>`);
    // Its length changed: none is sent.
    expect(headers.map(([name]) => name)).not.toContain("content-length");
    expect(policies(headers)).toEqual([`script-src 'nonce-a' ${VIEWER_GUARD_HASH}`, VIEWER_GUARD_CSP]);
  });

  it("guards a page whose destination the browser did not say, and an empty answer stays empty", async () => {
    expect(await read((await guardViewerAnswer([["content-type", "text/html"]], chunks("<p>hi"), null)).body)).toBe(`${TAG}<p>hi`);
    const empty = await guardViewerAnswer([["content-type", "text/html"], ["content-length", "0"]], chunks(), "document");
    expect(await read(empty.body)).toBe("");
  });

  it("lets a page it cannot be put in run no script, and leaves what is not a page as it was", async () => {
    const noScripts = async (headers: HeaderList, text: string | Uint8Array, destination: string | null = "iframe") => {
      const answer = await guardViewerAnswer(headers, (async function* () { yield typeof text === "string" ? utf8Encode(text) : text; })(), destination);
      return { policies: policies(answer.headers), text: await read(answer.body).catch(() => "binary") };
    };
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'><script>x()</script></svg>";
    expect(await noScripts([["content-type", "image/svg+xml"]], svg)).toEqual({ policies: [VIEWER_GUARD_CSP, "script-src 'none'"], text: svg });
    expect((await noScripts([], "<p>untyped")).policies).toContain("script-src 'none'");
    expect((await noScripts([["content-type", "text/html"], ["content-encoding", "gzip"]], "zipped")).policies).toContain("script-src 'none'");
    expect((await noScripts([["content-type", "text/html; charset=UTF-16LE"]], "<\0p\0")).policies).toContain("script-src 'none'");
    expect((await noScripts([["content-type", "text/html"]], new Uint8Array([0xff, 0xfe, 0x3c, 0]))).policies).toContain("script-src 'none'");
    // UTF-16 by its other names, as a browser resolves them; a name no browser knows is read as an ASCII-compatible one.
    for (const charset of ["unicode", "ucs-2", "csunicode", "iso-10646-ucs-2", "unicodefeff", "unicodefffe", "\"UTF-16BE\""]) {
      expect((await noScripts([["content-type", `text/html; charset=${charset}`]], "<\0p\0")).policies, charset).toContain("script-src 'none'");
    }
    // A charset hidden in a quoted string, or spelled with an escape: a browser reads those, so no script runs.
    for (const type of ['text/html; foo="x;charset=utf-8";charset=unicode', 'text/html; charset="uni\\code"', 'text/html; charset="utf-8"', "text/html; charset=utf-8; charset=unicode"]) {
      expect((await noScripts([["content-type", type]], "<\0p\0")).policies, type).toContain("script-src 'none'");
    }
    for (const charset of ["utf-8", "windows-1252", "no-such-name"]) {
      expect((await noScripts([["content-type", `text/html; charset=${charset}`]], "<p>hi")).policies, charset).not.toContain("script-src 'none'");
    }
    // Two types: a browser renders the last (an SVG, whose script would run with the guard's text beside it, not run).
    expect(await noScripts([["content-type", "text/html"], ["Content-Type", "image/svg+xml"]], svg)).toEqual({ policies: [VIEWER_GUARD_CSP, "script-src 'none'"], text: svg });
    expect(await noScripts([["content-type", "text/html, image/svg+xml"]], svg)).toEqual({ policies: [VIEWER_GUARD_CSP, "script-src 'none'"], text: svg });
    expect((await noScripts([["content-type", "text/html"], ["content-type", "text/html"]], "<p>twice")).policies).toContain("script-src 'none'");
    expect((await noScripts([["content-type", "text/html"], ["content-encoding", "identity"], ["content-encoding", "gzip"]], "zipped")).policies).toContain("script-src 'none'");
    expect((await noScripts([["content-type", "text/html"], ["content-encoding", "identity, br"]], "zipped")).policies).toContain("script-src 'none'");
    // A script, a picture, a worker: not a page; only the policy goes along.
    expect(await noScripts([["content-type", "text/html"]], "<p>fetched"), ).toMatchObject({ text: `${TAG}<p>fetched` });
    expect(await noScripts([["content-type", "text/html"]], "<p>fetched", "empty")).toEqual({ policies: [VIEWER_GUARD_CSP], text: "<p>fetched" });
    expect(await noScripts([["content-type", "text/javascript"]], "go()", "worker")).toEqual({ policies: [VIEWER_GUARD_CSP], text: "go()" });
  });
});
