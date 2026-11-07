import { concatBytes, utf8Encode } from "./bytes";
import type { HeaderList } from "./frames";

/**
 * Hide my IP from contacts and a contact's shared app: no policy keeps a page off WebRTC (CSP does not cover ICE, and
 * no permissions policy names it), and a `new RTCPeerConnection` with a STUN server the contact names shows that server
 * this device's address. While the setting is on, this script runs first in every realm of the app's page (the
 * extension's viewer tab and Desktop's window run it in every frame themselves; the web runner and `service open` put
 * it first in each HTML page, `guardViewerAnswer`). It:
 * - deletes the WebRTC constructors (every `RTC…` and `webkitRTC…` name), as Desktop's app runner does;
 * - opens every new window with `noopener`, so the page never holds a window it did not run in;
 * - runs again in each frame of its document as the frame loads: an empty frame's first load fires as it is put in the
 *   page, before the code that put it there goes on;
 * - puts itself first in each `srcdoc` frame, and, with `VIEWER_GUARD_CSP`, refuses `javascript:` URLs (its own
 *   Trusted Types default policy: one passes every other string on as it is).
 * No backslash, `${` or backtick in it: Desktop's copy (`SERVICE_GUARD`, apps/desktop/src/viewer.rs) is the same text.
 */
export const VIEWER_GUARD_SCRIPT = `(function noWebRtc(w) {
  "use strict";
  try {
    const apply = Reflect.apply;
    const own = "<script>(" + noWebRtc + ")(window)<" + "/script>";
    for (const name of Object.getOwnPropertyNames(w)) {
      if (/^(webkit)?RTC/.test(name)) { try { delete w[name]; } catch (e) {} }
    }
    if (w.trustedTypes && !w.trustedTypes.defaultPolicy) {
      try {
        w.trustedTypes.createPolicy("default", {
          createHTML: (input) => input,
          createScript: (input, type, sink) => (sink === "Location href" ? null : input),
          createScriptURL: (input) => input,
        });
      } catch (e) {}
    }
    const open = w.open;
    w.open = function (url, target) {
      apply(open, this, [url === undefined ? "" : url, target === undefined ? "_blank" : target, "noopener"]);
      return null;
    };
    const reopen = w.Document.prototype.open;
    w.Document.prototype.open = function () {
      return arguments.length > 2 ? w.open(arguments[0], arguments[1]) : apply(reopen, this, arguments);
    };
    const { getAttribute, setAttribute, removeAttribute } = w.Element.prototype;
    const first = (frame) => {
      const doc = apply(getAttribute, frame, ["srcdoc"]);
      if (doc === null || doc.slice(0, own.length) === own) return;
      try { apply(setAttribute, frame, ["srcdoc", own + doc]); } catch (e) { apply(removeAttribute, frame, ["srcdoc"]); }
    };
    new w.MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") first(record.target);
        else for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.localName === "iframe") first(node);
          if (node.firstElementChild) for (const frame of node.querySelectorAll("iframe[srcdoc]")) first(frame);
        }
      }
    }).observe(w.document, { subtree: true, childList: true, attributes: true, attributeFilter: ["srcdoc"] });
    w.document.addEventListener("load", (event) => {
      let inner = null;
      try { inner = event.target.contentWindow; } catch (e) {}
      try { if (inner && ("RTCPeerConnection" in inner || "webkitRTCPeerConnection" in inner)) noWebRtc(inner); } catch (e) {}
    }, true);
  } catch (e) {}
})(window)`;

/** `VIEWER_GUARD_SCRIPT`'s hash, as a CSP source: a contact's own policy that would refuse it is given it (`allowingViewerGuard`). */
export const VIEWER_GUARD_HASH = "'sha256-t2GKPZLdbwAQ3Qydx72W9xbSvWkZ37U4hC7AsPexDC0='";

/**
 * With the guard, where it is put in the page and not run by the viewer in every frame: frames only from the app's own
 * origin (a `data:` or `blob:` frame would run before the guard could), and Trusted Types, which hands each
 * `javascript:` URL to the guard's policy before it runs.
 */
export const VIEWER_GUARD_CSP = "frame-src 'self'; object-src 'self'; require-trusted-types-for 'script'";

/** Refuses every script of a page the guard cannot be put first in. */
const NO_SCRIPTS_CSP = "script-src 'none'";

/** The `Sec-Fetch-Dest` (a request's `destination`) of a page: the ones the guard goes into. */
const DOCUMENT_DESTINATIONS = new Set(["document", "iframe", "frame", "object", "embed", "fencedframe"]);

/**
 * A contact's `Content-Security-Policy` value (one policy or several, joined by commas), each given the guard's hash
 * where it would refuse an inline script: in the directive that governs `<script>` elements (`script-src-elem`, else
 * `script-src`, else `default-src`), unless it lets every inline script run already. Nothing else of it changes.
 */
export function allowingViewerGuard(value: string): string {
  return value.split(",").map((policy) => {
    const directives = policy.split(";");
    const names = directives.map((directive) => directive.trim().split(/\s+/)[0].toLowerCase());
    const at = ["script-src-elem", "script-src", "default-src"].map((name) => names.indexOf(name)).find((index) => index >= 0);
    if (at === undefined) return policy;
    const sources = directives[at].trim().split(/\s+/).slice(1).map((source) => source.toLowerCase());
    // A nonce, a hash or 'strict-dynamic' turns 'unsafe-inline' off.
    const everyInline = sources.includes("'unsafe-inline'") && !sources.some((source) => source.startsWith("'nonce-") || /^'sha(256|384|512)-/.test(source) || source === "'strict-dynamic'");
    if (everyInline) return policy;
    directives[at] = `${directives[at].trimEnd()} ${VIEWER_GUARD_HASH}`;
    return directives.join(";");
  }).join(",");
}

const at = (bytes: Uint8Array, offset: number, text: string, anyCase = false) => {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    let byte = bytes[offset + i];
    if (anyCase && byte >= 0x41 && byte <= 0x5a) byte += 0x20;
    if (byte !== text.charCodeAt(i)) return false;
  }
  return true;
};

const find = (bytes: Uint8Array, from: number, text: string) => {
  for (let i = from; i + text.length <= bytes.length; i++) if (at(bytes, i, text)) return i;
  return -1;
};

/**
 * Where the guard goes in an HTML page that starts with `head`: after a byte order mark, blank space, comments and the
 * doctype (before them the page would turn to quirks mode), so before anything that can run or set a policy. Null when
 * `head` ends before that is known and more is coming (`done` false).
 */
export function viewerGuardOffset(head: Uint8Array, done: boolean): number | null {
  let offset = at(head, 0, "ï»¿") ? 3 : 0;
  for (;;) {
    while (offset < head.length && [0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(head[offset])) offset++;
    if (offset >= head.length) return done ? offset : null;
    let end: number;
    if (at(head, offset, "<!--")) {
      // `<!-->` and `<!--->` end at once.
      if (at(head, offset + 4, ">")) end = offset + 5;
      else if (at(head, offset + 4, "->")) end = offset + 6;
      else {
        const ends = ["-->", "--!>"].map((close) => [find(head, offset + 4, close), close.length]).filter(([index]) => index >= 0).sort(([a], [b]) => a - b);
        end = ends.length ? ends[0][0] + ends[0][1] : -1;
      }
    } else if (at(head, offset, "<!doctype", true)) {
      const close = find(head, offset, ">");
      if (close >= 0) return close + 1;
      end = -1;
    } else if (at(head, offset, "<!") || at(head, offset, "<?")) {
      const close = find(head, offset, ">");
      end = close >= 0 ? close + 1 : -1;
    } else if (offset === head.length - 1 && head[offset] === 0x3c) {
      // A lone `<`: a doctype or a comment may start there.
      if (!done) return null;
      return offset;
    } else {
      return offset;
    }
    // Unfinished: more is needed, or, at the end of the page, the guard goes before it.
    if (end < 0) return done ? offset : null;
    offset = end;
  }
}

/** How far into a page the guard is looked for a place in: past it, it goes where the look stopped. */
const LOOK_BYTES = 64 * 1024;

/**
 * A contact's answer as a viewer serves it while Hide my IP from contacts is on, where the viewer cannot run the guard
 * in every frame itself (the web runner, `service open`): the contact's policies take the guard's hash
 * (`allowingViewerGuard`) and `VIEWER_GUARD_CSP` goes along. A page (`destination`, null when the browser did not say)
 * that is HTML gets the guard first in it; one the guard cannot be put in (another type, a compressed or UTF-16 body)
 * runs no script at all. Anything that is not a page passes as it was. The caller adds Ghostly's own policy as before.
 */
export async function guardViewerAnswer(headers: HeaderList, body: AsyncIterable<Uint8Array>, destination: string | null): Promise<{ headers: HeaderList; body: AsyncIterable<Uint8Array> }> {
  const out: HeaderList = headers.map(([name, value]) => [name, name.toLowerCase() === "content-security-policy" ? allowingViewerGuard(value) : value]);
  out.push(["content-security-policy", VIEWER_GUARD_CSP]);
  if (destination !== null && !DOCUMENT_DESTINATIONS.has(destination.toLowerCase())) return { headers: out, body };
  const value = (name: string) => headers.find(([n]) => n.toLowerCase() === name)?.[1].toLowerCase().trim() ?? "";
  const type = value("content-type");
  const html = type.split(";")[0].trim() === "text/html" && !/charset\s*=\s*"?utf-16/.test(type);
  const encoded = !["", "identity"].includes(value("content-encoding"));
  const noScripts = () => ({ headers: [...out, ["content-security-policy", NO_SCRIPTS_CSP] as [string, string]], body });
  if (!html || encoded) return noScripts();

  const iterator = body[Symbol.asyncIterator]();
  let head: Uint8Array = new Uint8Array(0);
  let done = false;
  let offset: number | null = null;
  while (offset === null) {
    const next = await iterator.next();
    if (next.done) done = true;
    else head = concatBytes(head, next.value);
    offset = viewerGuardOffset(head, done || head.length >= LOOK_BYTES);
  }
  const rest: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => iterator };
  const resumed = async function* (first: Uint8Array) {
    if (first.length) yield first;
    if (!done) yield* rest;
  };
  // A byte order mark of UTF-16: the guard's bytes would not read as a script there.
  if ((head[0] === 0xfe && head[1] === 0xff) || (head[0] === 0xff && head[1] === 0xfe)) {
    return { headers: [...out, ["content-security-policy", NO_SCRIPTS_CSP]], body: resumed(head) };
  }
  // Nothing to run in an empty answer (a HEAD, a 304): it stays empty.
  if (done && head.length === 0) return { headers: out, body: resumed(head) };
  const guarded = concatBytes(head.subarray(0, offset), utf8Encode(`<script>${VIEWER_GUARD_SCRIPT}</script>`), head.subarray(offset));
  return { headers: out.filter(([name]) => name.toLowerCase() !== "content-length"), body: resumed(guarded) };
}
