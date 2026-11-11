import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  allowingViewerGuard,
  concatBytes,
  guardViewerAnswer,
  utf8Decode,
  utf8Encode,
  viewerGuardOffset,
  VIEWER_GUARD_CSP,
  VIEWER_GUARD_HASH,
  VIEWER_GUARD_SCRIPT,
  VIEWER_WORKER_GUARD_CSP,
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
    expect(at("ï", false)).toBeNull();
    expect(at("ï»", false)).toBeNull();
    expect(at("ï»")).toBe(0);
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

  it("goes after a byte order mark that comes split across chunks, as after a whole one", async () => {
    const page = utf8Encode("\uFEFF<!doctype html><p>ação 日本</p>");
    const guard = async (...parts: Uint8Array[]) => {
      const { body } = await guardViewerAnswer([["content-type", "text/html"]], (async function* () { yield* parts; })(), "document");
      const out: Uint8Array[] = [];
      for await (const chunk of body) out.push(chunk);
      return concatBytes(...out);
    };
    const whole = await guard(page);
    expect(whole).toEqual(utf8Encode(`\uFEFF<!doctype html>${TAG}<p>ação 日本</p>`));
    for (const cut of [1, 2]) expect(await guard(page.subarray(0, cut), page.subarray(cut))).toEqual(whole);
  });

  it("puts itself in the same place however the page is cut, and reads a head sent a byte at a time once", async () => {
    const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
    const guarded = async (page: Uint8Array, size: number) => {
      const out: number[] = [];
      const parts = (async function* () { for (let i = 0; i < page.length; i += size) yield page.slice(i, i + size); })();
      for await (const chunk of (await guardViewerAnswer([["content-type", "text/html"]], parts, "iframe")).body) for (const byte of chunk) out.push(byte);
      return out;
    };
    const pages = [
      "  <!DOCTYPE html>\n<html>", "<!-- a --><!--> <?xml x?><!doctype html><p>", "<!-- a -- b --!> <!---> \t<p>",
      "<!-- > -> --> <!doctype x>", "<!x > <? y > <!doc", "  \n<", "<!-- never closed --", "<!d>ctype <p>",
    ];
    for (const page of pages) {
      const whole = await guarded(bytes(page), page.length || 1);
      for (const size of [1, 2, 3, 5]) expect(await guarded(bytes(page), size), `${JSON.stringify(page)} in ${size}`).toEqual(whole);
    }
    // A comment that never ends, past how far the guard looks, a byte at a time: once over its bytes, not once per byte
    // (seconds of the page's time, before).
    const comment = bytes(`<!--${"a".repeat(64 * 1024)}`);
    const started = performance.now();
    expect((await guarded(comment, 1)).length).toBe(comment.length + utf8Encode(TAG).length);
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 60_000);

  it("guards a page whose destination the browser did not say, and an empty answer stays empty", async () => {
    expect(await read((await guardViewerAnswer([["content-type", "text/html"]], chunks("<p>hi"), null)).body)).toBe(`${TAG}<p>hi`);
    const empty = await guardViewerAnswer([["content-type", "text/html"], ["content-length", "0"]], chunks(), "document");
    expect(await read(empty.body)).toBe("");
  });

  it("lets a page it cannot be put in run no script, and leaves what is not a page as it was", async () => {
    // A refused page runs no frames either: one of its origin with no charset would read in the page's (UTF-16...).
    const REFUSED = "script-src 'none'; frame-src 'none'; object-src 'none'";
    const noScripts = async (headers: HeaderList, text: string | Uint8Array, destination: string | null = "iframe") => {
      const answer = await guardViewerAnswer(headers, (async function* () { yield typeof text === "string" ? utf8Encode(text) : text; })(), destination);
      return { policies: policies(answer.headers), text: await read(answer.body).catch(() => "binary") };
    };
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'><script>x()</script></svg>";
    expect(await noScripts([["content-type", "image/svg+xml"]], svg)).toEqual({ policies: [VIEWER_GUARD_CSP, REFUSED], text: svg });
    expect((await noScripts([], "<p>untyped")).policies).toContain(REFUSED);
    expect((await noScripts([["content-type", "text/html"], ["content-encoding", "gzip"]], "zipped")).policies).toContain(REFUSED);
    expect((await noScripts([["content-type", "text/html; charset=UTF-16LE"]], "<\0p\0")).policies).toContain(REFUSED);
    expect((await noScripts([["content-type", "text/html"]], new Uint8Array([0xff, 0xfe, 0x3c, 0]))).policies).toContain(REFUSED);
    // UTF-16 by its other names, as a browser resolves them; a name no browser knows is read as an ASCII-compatible one.
    for (const charset of ["unicode", "ucs-2", "csunicode", "iso-10646-ucs-2", "unicodefeff", "unicodefffe", "\"UTF-16BE\""]) {
      expect((await noScripts([["content-type", `text/html; charset=${charset}`]], "<\0p\0")).policies, charset).toContain(REFUSED);
    }
    // A PDF, a picture, a video or a sound keeps its frames (a browser shows one in a frame), only its scripts are refused.
    for (const type of ["application/pdf", "image/png", "video/mp4", "audio/ogg"]) {
      expect((await noScripts([["content-type", type]], "%PDF-1.7")).policies, type).toEqual([VIEWER_GUARD_CSP, "script-src 'none'"]);
    }
    // Every other refused type loses its frames: a browser renders HTML under some of them.
    for (const type of ["application/unknown; charset=unicode", "unknown/unknown; charset=unicode", "*/*; charset=unicode", "multipart/x-mixed-replace; boundary=b", "text/plain"]) {
      expect((await noScripts([["content-type", type]], "<\0p\0")).policies, type).toEqual([VIEWER_GUARD_CSP, REFUSED]);
    }
    // A parameter named otherwise is not a charset (`xcharset=unicode`): the page is read as UTF-8 and guarded.
    expect(await noScripts([["content-type", "text/html; xcharset=unicode"]], "<p>hi")).toMatchObject({ text: `${TAG}<p>hi` });
    // A charset hidden in a quoted string, or spelled with an escape: a browser reads those, so no script runs.
    for (const type of ['text/html; foo="x;charset=utf-8";charset=unicode', 'text/html; charset="uni\\code"', 'text/html; charset="utf-8"', "text/html; charset=utf-8; charset=unicode"]) {
      expect((await noScripts([["content-type", type]], "<\0p\0")).policies, type).toContain(REFUSED);
    }
    // ISO-2022-JP: by the header, or an escape before the guard's place (how a `<meta>` after it would reach the guard).
    const esc = (text: string) => new Uint8Array([...text].map((char) => (char === "~" ? 0x1b : char.charCodeAt(0))));
    for (const charset of ["iso-2022-jp", "csiso2022jp"]) {
      expect((await noScripts([["content-type", `text/html; charset=${charset}`]], "<p>hi")).policies, charset).toContain(REFUSED);
    }
    for (const page of ["<!--~$B-->~(B--><meta charset=iso-2022-jp><p>hi", "<!doctype html ~$B>~(B><p>hi"]) {
      expect((await noScripts([["content-type", "text/html"]], esc(page))).policies, page).toContain(REFUSED);
    }
    // One after the guard's place cannot change how the guard reads.
    expect((await noScripts([["content-type", "text/html"]], esc("<!doctype html><p>~$B~(B"))).policies).not.toContain(REFUSED);
    for (const charset of ["utf-8", "windows-1252", "no-such-name"]) {
      expect((await noScripts([["content-type", `text/html; charset=${charset}`]], "<p>hi")).policies, charset).not.toContain(REFUSED);
    }
    // Two types: a browser renders the last (an SVG, whose script would run with the guard's text beside it, not run).
    expect(await noScripts([["content-type", "text/html"], ["Content-Type", "image/svg+xml"]], svg)).toEqual({ policies: [VIEWER_GUARD_CSP, REFUSED], text: svg });
    expect(await noScripts([["content-type", "text/html, image/svg+xml"]], svg)).toEqual({ policies: [VIEWER_GUARD_CSP, REFUSED], text: svg });
    expect((await noScripts([["content-type", "text/html"], ["content-type", "text/html"]], "<p>twice")).policies).toContain(REFUSED);
    expect((await noScripts([["content-type", "text/html"], ["content-encoding", "identity"], ["content-encoding", "gzip"]], "zipped")).policies).toContain(REFUSED);
    expect((await noScripts([["content-type", "text/html"], ["content-encoding", "identity, br"]], "zipped")).policies).toContain(REFUSED);
    // A script, a picture: not a page; only the policy goes along.
    expect(await noScripts([["content-type", "text/html"]], "<p>fetched"), ).toMatchObject({ text: `${TAG}<p>fetched` });
    expect(await noScripts([["content-type", "text/html"]], "<p>fetched", "empty")).toEqual({ policies: [VIEWER_GUARD_CSP], text: "<p>fetched" });
    expect(await noScripts([["content-type", "text/javascript"]], "go()", "script")).toEqual({ policies: [VIEWER_GUARD_CSP], text: "go()" });
  });

  it("leaves Trusted Types out of a worker's own policy, where no guard makes the default policy", async () => {
    // covers: services.web-open
    // A worker under `require-trusted-types-for` with no default policy refuses every `importScripts`, `eval` and `new Function`.
    for (const destination of ["worker", "sharedworker", "serviceworker", "Worker"]) {
      const answer = await guardViewerAnswer([["content-type", "text/javascript"], ["content-security-policy", "script-src 'self'"]], chunks("importScripts('/lib.js')"), destination);
      expect(policies(answer.headers), destination).toEqual([`script-src 'self' ${VIEWER_GUARD_HASH}`, VIEWER_WORKER_GUARD_CSP]);
      expect(await read(answer.body)).toBe("importScripts('/lib.js')");
    }
    expect(VIEWER_WORKER_GUARD_CSP).toBe("frame-src 'self'; object-src 'self'");
    // Anything else keeps it: a page, a script a page loads, an answer whose destination the browser did not say.
    for (const destination of ["iframe", "script", "empty", null]) {
      const answer = await guardViewerAnswer([["content-type", "text/javascript"]], chunks("go()"), destination);
      expect(policies(answer.headers), String(destination)).toContain(VIEWER_GUARD_CSP);
    }
  });
});
