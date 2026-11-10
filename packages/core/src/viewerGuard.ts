import { concatBytes, utf8Encode } from "./bytes";
import type { HeaderList } from "./frames";

/**
 * Hide my IP from contacts and a contact's shared app: no policy keeps a page off WebRTC (CSP does not cover ICE, its
 * `webrtc 'block'` is not in Chromium or WebKit, and no permissions policy names it), and a `new RTCPeerConnection` with
 * a STUN server the contact names shows that server this device's address. While the setting is on, this script runs
 * first in the app's page: Desktop's window runs it in every frame itself, and the web runner puts it first in each
 * HTML page (`guardViewerAnswer`). It:
 * - deletes the WebRTC constructors (every `RTC…` and `webkitRTC…` name), as Desktop's app runner does;
 * - opens every new window with `noopener`, so the page never holds a window it did not run in;
 * - runs in a frame's window before the page holds it: what a frame element hands out (`contentWindow`,
 *   `contentDocument`, `getSVGDocument`) is guarded first, in a shadow tree too, and the frames of the document are
 *   gone over as one loads (an empty frame's first load fires as it is put in the page) and as the page changes;
 * - puts itself first in each `srcdoc` frame, in the shadow trees the page makes too, and, with `VIEWER_GUARD_CSP`,
 *   refuses `javascript:` URLs (its own Trusted Types default policy: one passes every other string on as it is);
 * - refuses a declarative shadow root the page's script would make (`setHTMLUnsafe`, `Document.parseHTMLUnsafe`,
 *   `document.write`, a write split in two too): its `srcdoc` frames would be out of the guard's sight;
 * - listens for frames' loads again after `document.open()`, which takes every listener of the document away.
 * It uses nothing the page can change after it ran (the page's own code runs later, in the same realm).
 *
 * What a script put in the page cannot do, so where the viewer does not run it per document this is not a guarantee:
 * a frame's window read by its index (`window[0]`, never through the frame element) while the frame's page is still
 * on its way, and a `srcdoc` frame inside a shadow tree written in the HTML the page itself sends, run before the
 * guard is there.
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
    const opener = function (url, target) {
      apply(open, this, [url === undefined ? "" : url, target === undefined ? "_blank" : target, "noopener"]);
      return null;
    };
    w.open = opener;
    const describe = Object.getOwnPropertyDescriptor;
    const define = Object.defineProperty;
    const shut = (inner) => {
      try { if (inner && inner !== w && ("RTCPeerConnection" in inner || "webkitRTCPeerConnection" in inner)) noWebRtc(inner); } catch (e) {}
    };
    const count = describe(w, "length").get;
    const view = describe(w.Document.prototype, "defaultView").get;
    const slice = String.prototype.slice;
    const sweep = () => {
      try { for (let i = apply(count, w, []); i-- > 0;) shut(w[i]); } catch (e) {}
    };
    const listen = w.EventTarget.prototype.addEventListener;
    const home = w.document;
    const reopen = w.Document.prototype.open;
    w.Document.prototype.open = function () {
      if (arguments.length > 2) return apply(opener, w, [arguments[0], arguments[1]]);
      const got = apply(reopen, this, arguments);
      if (this === home) { try { apply(listen, home, ["load", sweep, true]); } catch (e) {} }
      return got;
    };
    const text = String;
    const lower = String.prototype.toLowerCase;
    const index = String.prototype.indexOf;
    const Refused = w.TypeError;
    const shadowed = (html) => apply(index, apply(lower, html, []), ["shadowrootmode"]) >= 0;
    const refuse = () => { throw new Refused("A declarative shadow root is not allowed here"); };
    for (const [owner, name] of [[w.Element.prototype, "setHTMLUnsafe"], [w.ShadowRoot && w.ShadowRoot.prototype, "setHTMLUnsafe"], [w.Document, "parseHTMLUnsafe"]]) {
      const real = owner && owner[name];
      if (typeof real !== "function") continue;
      owner[name] = function (html) {
        const checked = text(html);
        if (shadowed(checked)) refuse();
        return apply(real, this, arguments.length > 1 ? [checked, arguments[1]] : [checked]);
      };
    }
    let tail = "";
    for (const name of ["write", "writeln"]) {
      const real = w.Document.prototype[name];
      if (typeof real !== "function") continue;
      w.Document.prototype[name] = function () {
        let checked = "";
        for (let i = 0; i < arguments.length; i++) checked += text(arguments[i]);
        if (shadowed(tail + checked)) refuse();
        tail = apply(slice, tail + checked, [-16]);
        return apply(real, this, [checked]);
      };
    }
    for (const kind of ["HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement", "HTMLEmbedElement"]) {
      const proto = w[kind] && w[kind].prototype;
      for (const name of ["contentWindow", "contentDocument", "getSVGDocument"]) {
        const found = proto && describe(proto, name);
        const key = found && found.get ? "get" : "value";
        if (!found || typeof found[key] !== "function") continue;
        const read = found[key];
        found[key] = function () {
          const got = apply(read, this, arguments);
          try { shut(name === "contentWindow" ? got : apply(view, got, [])); } catch (e) {}
          return got;
        };
        try { define(proto, name, found); } catch (e) {}
      }
    }
    const { getAttribute, setAttribute, removeAttribute, attachShadow } = w.Element.prototype;
    const size = describe(w.NodeList.prototype, "length").get;
    const first = (frame) => {
      const doc = apply(getAttribute, frame, ["srcdoc"]);
      if (doc === null || apply(slice, doc, [0, own.length]) === own) return;
      try { apply(setAttribute, frame, ["srcdoc", own + doc]); } catch (e) { apply(removeAttribute, frame, ["srcdoc"]); }
    };
    const Observer = w.MutationObserver;
    const observe = Observer.prototype.observe;
    const watch = (root, all) => {
      const scan = () => {
        try {
          const frames = apply(all, root, ["iframe[srcdoc]"]);
          for (let i = apply(size, frames, []); i-- > 0;) first(frames[i]);
        } catch (e) {}
        sweep();
      };
      apply(observe, new Observer(scan), [root, { subtree: true, childList: true, attributes: true, attributeFilter: ["srcdoc"] }]);
      scan();
      return root;
    };
    const inShadow = w.DocumentFragment.prototype.querySelectorAll;
    if (attachShadow) {
      w.Element.prototype.attachShadow = function () {
        const root = apply(attachShadow, this, arguments);
        try { watch(root, inShadow); } catch (e) {}
        return root;
      };
    }
    apply(listen, home, ["load", sweep, true]);
    watch(home, w.Document.prototype.querySelectorAll);
  } catch (e) {}
})(window)`;

/** `VIEWER_GUARD_SCRIPT`'s hash, as a CSP source: a contact's own policy that would refuse it is given it (`allowingViewerGuard`). */
export const VIEWER_GUARD_HASH = "'sha256-P3jYgJwfoJ/cAS31rQz7Tk99bBwsSeN2wDDqJubDMZw='";

/**
 * With the guard, where it is put in the page and not run by the viewer in every frame: frames only from the app's own
 * origin (a `data:` or `blob:` frame would run before the guard could), and Trusted Types, which hands each
 * `javascript:` URL to the guard's policy before it runs.
 */
export const VIEWER_GUARD_CSP = "frame-src 'self'; object-src 'self'; require-trusted-types-for 'script'";

/** Refuses every script of a page the guard cannot be put first in. */
const NO_SCRIPTS_CSP = "script-src 'none'";

/**
 * The same for a page of markup (HTML, XML, SVG, or a type not known), which can frame others: no frames either. A page
 * of its origin framed with no charset of its own takes the framing page's (UTF-16, ISO-2022-JP), where the guard put
 * first in it would read as text. A PDF or a picture keeps its frames (a browser shows those in one).
 */
const NO_SCRIPTS_OR_FRAMES_CSP = "script-src 'none'; frame-src 'none'; object-src 'none'";

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
 * in every frame itself (the web runner): the contact's policies take the guard's hash
 * (`allowingViewerGuard`) and `VIEWER_GUARD_CSP` goes along. A page (`destination`, null when the browser did not say)
 * that is HTML gets the guard first in it; one the guard cannot be put in (another type, more than one type, a
 * compressed, UTF-16 or ISO-2022-JP body, a type with a quote or a backslash in it, an escape byte before the guard's
 * place) runs no script at all. Anything that is not a page passes as it was. The caller adds Ghostly's own policy as before.
 */
export async function guardViewerAnswer(headers: HeaderList, body: AsyncIterable<Uint8Array>, destination: string | null): Promise<{ headers: HeaderList; body: AsyncIterable<Uint8Array> }> {
  const out: HeaderList = headers.map(([name, value]) => [name, name.toLowerCase() === "content-security-policy" ? allowingViewerGuard(value) : value]);
  out.push(["content-security-policy", VIEWER_GUARD_CSP]);
  if (destination !== null && !DOCUMENT_DESTINATIONS.has(destination.toLowerCase())) return { headers: out, body };
  const values = (name: string) => headers.filter(([n]) => n.toLowerCase() === name).map(([, value]) => value.toLowerCase().trim());
  // One type, said once: of two (two headers, or a list in one) a browser reads the last, which may not be the one read here.
  const types = values("content-type");
  const type = types.length === 1 && !types[0].includes(",") ? types[0] : "";
  // UTF-16 by any of its names (`unicode`, `ucs-2`, `csunicode`...), resolved as a browser does, or ISO-2022-JP (whose
  // escapes switch the decoder to two-byte text): the guard's bytes would not read as a script there. Every `charset=` counts, and a type with a quote or a backslash in it is not read at all
  // (a browser reads quoted strings, which can hide a charset or spell one with escapes): none of these runs scripts.
  // A name no browser knows falls back to an encoding that reads them.
  const unreadable = [...type.matchAll(/(?:^|;)\s*charset\s*=\s*"?([^";\s]+)/g)].some(([, label]) => {
    try { return /^(utf-16|iso-2022-jp$)/.test(new TextDecoder(label).encoding); } catch { return false; }
  });
  const essence = type.split(";")[0].trim();
  const html = essence === "text/html" && !unreadable && !/["\\]/.test(type);
  const markup = essence === "" || /html|xml|svg/.test(essence);
  const refused: [string, string] = ["content-security-policy", markup ? NO_SCRIPTS_OR_FRAMES_CSP : NO_SCRIPTS_CSP];
  const encoded = values("content-encoding").some((encoding) => !["", "identity"].includes(encoding));
  const noScripts = () => ({ headers: [...out, refused], body });
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
  // A byte order mark of UTF-16, or an escape before the guard's place: the guard's bytes would not read as a script
  // there. The escape is how ISO-2022-JP (the one stateful encoding a browser decodes, by the header or by a `<meta>`
  // the page has after the guard) turns to two-byte text; a page has no other use for one in a comment or the doctype.
  if ((head[0] === 0xfe && head[1] === 0xff) || (head[0] === 0xff && head[1] === 0xfe) || head.subarray(0, offset).includes(0x1b)) {
    return { headers: [...out, refused], body: resumed(head) };
  }
  // Nothing to run in an empty answer (a HEAD, a 304): it stays empty.
  if (done && head.length === 0) return { headers: out, body: resumed(head) };
  const guarded = concatBytes(head.subarray(0, offset), utf8Encode(`<script>${VIEWER_GUARD_SCRIPT}</script>`), head.subarray(offset));
  return { headers: out.filter(([name]) => name.toLowerCase() !== "content-length"), body: resumed(guarded) };
}
