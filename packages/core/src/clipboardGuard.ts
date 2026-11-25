/**
 * A contact's shared app on the web writes the clipboard only in the person's own tap in it. Its frames allow no
 * `clipboard-write`, but Chromium lets `document.execCommand("copy")` write the system clipboard for as long as a tap's
 * activation lasts (seconds, from a timer too), and no sandbox token or permissions policy turns that off. So this
 * script runs first in each of the app's pages (`guardViewerAnswer`) and in the bridge (apps/web/src/svc/bridge.ts):
 * - `execCommand("copy")` and `execCommand("cut")` work only while one of the person's own inputs in that window is
 *   being dispatched (a trusted `pointerdown`, `pointerup`, `mousedown`, `mouseup`, `click`, `auxclick`, `dblclick`,
 *   `contextmenu`, `touchstart`, `touchend`, `keydown`, `keypress` or `keyup`; no script can fire one), or a trusted
 *   `submit` or `change` that began while such an input's window was open, and only within a second of that input
 *   (from its own `timeStamp`, or from its dispatch where that is later or on another clock): Chromium lets a copy
 *   write for seconds after a tap, and a page that spins in its own listener keeps the input being dispatched all
 *   that time, while the person may copy something of their own in Ghostly. That window opens as the input is
 *   dispatched and closes at the first callback the guard queued at any input that runs (a message on a channel of
 *   its own, a `user-blocking` task where `scheduler.postTask` exists, an animation frame), so it holds the input's
 *   own dispatch and its default action: the submit of a click on a submit button or of Enter in a field, the change
 *   of a checkbox. It also covers the rendering step right after the input: the animation frame callbacks the page
 *   asked for before the input run in the frame right after it, ahead of the guard's message and `user-blocking`
 *   task (and of its own frame callback, which closes the window there), so a `submit` or `change` one of them fires
 *   counts. A `submit` or `change` fired by script (`requestSubmit()`, `click()`) from a timer, a promise, a message
 *   or an animation frame asked for at or after the input, or outside any input, does not count. So a copy button, a
 *   form, a checkbox, a double click or the app's own context menu copies on the person's tap, and nothing else does
 *   (not on load, not from a timer or a promise after a tap). `execCommand("paste")` is refused. Every other command
 *   passes as it is. The wrapped `execCommand` is left fixed in place (not writable, not configurable), once per
 *   window;
 * - runs in a frame's window before the page holds it, as the WebRTC guard does (`VIEWER_GUARD_SCRIPT`): what a frame
 *   element hands out is guarded first, the frames of the document and of its shadow trees are gone over as one loads
 *   (an empty frame's first load fires as it is put in the page) and as the page changes, the document's frames as
 *   each call that puts nodes in a page returns (`appendChild`, `append`, `innerHTML`, `insertNode`, `document.write`
 *   and the like, an `execCommand`), so the window of a frame read by its index in the task that put it in is guarded
 *   before the page holds it, whatever its answer, each `srcdoc` frame gets
 *   this script first, a declarative shadow root the page's script would make is refused, and with `VIEWER_GUARD_CSP`
 *   a `javascript:` URL is refused (its own Trusted Types default policy; one passes every other string on as it is,
 *   or, once the page made its own `default` policy, to that one's rules: the page's `createPolicy("default")` gets the
 *   guard's policy back with them, a kind of string they have no rule for passes on as it is, and the copy of itself it
 *   puts in a `srcdoc` frame skips them. The guard cannot tell an app's own `require-trusted-types-for` from its own, so
 *   it keeps none: an app that enforces Trusted Types itself has every string its rules leave out passed on);
 * - starts a worker made from a `blob:` URL of the page's own from a script that makes a pass-through Trusted Types
 *   `default` policy in it first, as the WebRTC guard does (`VIEWER_GUARD_SCRIPT`, whichever of the two runs first);
 * - keeps each cookie the page's script sets to the page's own host: a `Domain` attribute is left out of a
 *   `document.cookie` write, and a `domain` out of `cookieStore.set` and `cookieStore.delete` (each of the other
 *   members read once). The apps' origins under a services host share its site: one an app set for the whole host
 *   would be read by every other contact's app open at once. The bridge drops those left from before as it starts
 *   (apps/web/src/svc/clearSite.ts, with the setter it kept before this ran). Both fixed in place, once per window.
 * A look over the frames passes by a frame of another origin without touching it (its prototype reads as null; this
 * script cannot run there) and by one whose document it already found guarded for good, so an insertion costs little
 * in an app with embeds. A frame's window keeps what was run in it on its first, empty page when the page it loads is of the same origin (the
 * bridge's guard reaches the app's frame then): there this script only watches the new document. Each document it
 * watches is marked (`ghostlyClipboardGuard`, fixed in place): the bridge reads that to know the guard ran in the page
 * it shows. It uses nothing the page can change after it ran (the page's own code runs later, in the same realm).
 *
 * A fence, not a wall, as the WebRTC guard's own: a frame inside a shadow tree written in the HTML the page itself
 * sends is out of its sight.
 * No backslash, `${` or backtick in it.
 */
export const CLIPBOARD_GUARD_SCRIPT = `(function noClipboardWrites(w) {
  "use strict";
  try {
    const apply = w.Reflect.apply;
    const describe = w.Object.getOwnPropertyDescriptor;
    const define = w.Object.defineProperty;
    const proto = w.Document.prototype;
    const home = w.document;
    const exec = describe(proto, "execCommand");
    const fresh = !!exec && exec.configurable === true && typeof exec.value === "function";
    const mark = describe(home, "ghostlyClipboardGuard");
    const watched = !!mark;
    if (!fresh && watched) return !!exec && exec.configurable === false && mark.configurable === false;
    if (!watched) define(home, "ghostlyClipboardGuard", { value: true });
    const own = "<script>(" + noClipboardWrites + ")(window)<" + "/script>";
    const close = "<" + "/script>";
    const webRtc = "<script>(function noWebRtc(";
    const text = w.String;
    const lower = text.prototype.toLowerCase;
    const slice = text.prototype.slice;
    const index = text.prototype.indexOf;
    const listen = w.EventTarget.prototype.addEventListener;
    const above = w.Object.getPrototypeOf;
    const Known = w.WeakSet;
    const known = typeof Known === "function" ? new Known() : null;
    const has = known && Known.prototype.has;
    const add = known && Known.prototype.add;
    const shut = (inner) => {
      try {
        if (!inner || inner === w || apply(above, null, [inner]) === null) return;
        const doc = inner.document;
        if (known !== null && apply(has, known, [doc])) return;
        if (noClipboardWrites(inner) === true && known !== null) apply(add, known, [doc]);
      } catch (e) {}
    };
    const count = describe(w, "length").get;
    const view = describe(proto, "defaultView").get;
    const sweep = () => {
      try { for (let i = apply(count, w, []); i-- > 0;) shut(w[i]); } catch (e) {}
    };
    const elements = w.Element.prototype;
    const getAttribute = elements.getAttribute;
    const setAttribute = elements.setAttribute;
    const removeAttribute = elements.removeAttribute;
    const attachShadow = elements.attachShadow;
    const size = describe(w.NodeList.prototype, "length").get;
    let passing = false;
    const first = (frame) => {
      const doc = apply(getAttribute, frame, ["srcdoc"]);
      if (doc === null) return;
      let at = 0;
      if (apply(slice, doc, [0, webRtc.length]) === webRtc) {
        const end = apply(index, doc, [close]);
        if (end >= 0) at = end + close.length;
      }
      if (apply(slice, doc, [at, at + own.length]) === own) return;
      passing = true;
      try { apply(setAttribute, frame, ["srcdoc", own + doc]); } catch (e) { apply(removeAttribute, frame, ["srcdoc"]); }
      passing = false;
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
      apply(listen, root, ["load", sweep, true]);
      scan();
      return root;
    };
    if (fresh) {
      const run = exec.value;
      const phase = describe(w.Event.prototype, "eventPhase").get;
      const trust = (event) => {
        try {
          const found = describe(event, "isTrusted");
          if (found && found.get && apply(found.get, event, []) === true) return found.get;
        } catch (e) {}
        return null;
      };
      const dispatching = (event, trusted) => {
        try { return apply(trusted, event, []) === true && apply(phase, event, []) !== 0; } catch (e) { return false; }
      };
      const stamp = describe(w.Event.prototype, "timeStamp");
      const clock = w.performance;
      const tick = clock && clock.now;
      const time = () => { try { return apply(tick, clock, []); } catch (e) { return NaN; } };
      const recent = (at) => time() - at <= 1000;
      const shutters = [];
      try {
        const channel = new w.MessageChannel();
        const post = w.MessagePort.prototype.postMessage;
        const out = channel.port2;
        channel.port1.onmessage = () => settle();
        shutters[0] = () => apply(post, out, [0]);
      } catch (e) {}
      try {
        const tasks = w.scheduler;
        const postTask = tasks && tasks.postTask;
        const urgent = { __proto__: null, priority: "user-blocking" };
        if (typeof postTask === "function") shutters[shutters.length] = () => { apply(postTask, tasks, [settle, urgent]); };
      } catch (e) {}
      try {
        const frame = w.requestAnimationFrame;
        if (typeof frame === "function") shutters[shutters.length] = () => { apply(frame, w, [settle]); };
      } catch (e) {}
      let tap = null;
      let trusted = null;
      let tapped = NaN;
      let open = 0;
      let follows = null;
      const settle = () => { open = 0; follows = null; };
      const seen = (event) => {
        const found = trust(event);
        if (found === null) return;
        let at = time();
        try {
          const given = apply(stamp.get, event, []);
          if (given >= 0 && given < at) at = given;
        } catch (e) {}
        tap = event;
        trusted = found;
        tapped = at;
        if (shutters.length === 0) return;
        open = 1;
        for (let i = 0; i < shutters.length; i++) { try { shutters[i](); } catch (e) {} }
      };
      const taps = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "auxclick", "dblclick", "contextmenu", "touchstart", "touchend", "keydown", "keypress", "keyup"];
      for (let i = 0; i < taps.length; i++) apply(listen, w, [taps[i], seen, true]);
      const followed = (event) => {
        if (open === 0) return;
        const found = trust(event);
        if (found !== null) follows = { event: event, trusted: found, at: tapped, next: follows };
      };
      apply(listen, w, ["submit", followed, true]);
      apply(listen, w, ["change", followed, true]);
      const tapping = () => {
        if (tap !== null && dispatching(tap, trusted) && recent(tapped)) return true;
        for (let f = follows; f !== null; f = f.next) if (dispatching(f.event, f.trusted) && recent(f.at)) return true;
        return false;
      };
      const guarded = function execCommand(command) {
        const name = apply(lower, text(command), []);
        if (name === "paste" || ((name === "copy" || name === "cut") && !tapping())) return false;
        const args = [name];
        for (let i = 1; i < arguments.length; i++) args[i] = arguments[i];
        try { return apply(run, this, args); } finally { sweep(); }
      };
      define(proto, "execCommand", { value: guarded, writable: false, enumerable: exec.enumerable, configurable: false });
      const trim = text.prototype.trim;
      const jar = describe(proto, "cookie");
      if (jar && jar.configurable === true && typeof jar.set === "function") {
        const put = jar.set;
        const hostOnly = function cookie(value) {
          const line = text(value);
          let at = apply(index, line, [";"]);
          let kept = at < 0 ? line : apply(slice, line, [0, at]);
          while (at >= 0) {
            const next = apply(index, line, [";", at + 1]);
            const part = next < 0 ? apply(slice, line, [at + 1]) : apply(slice, line, [at + 1, next]);
            const named = apply(index, part, ["="]);
            if (apply(lower, apply(trim, named < 0 ? part : apply(slice, part, [0, named]), []), []) !== "domain") kept += ";" + part;
            at = next;
          }
          return apply(put, this, [kept]);
        };
        define(proto, "cookie", { get: jar.get, set: hostOnly, enumerable: jar.enumerable, configurable: false });
      }
      const store = w.CookieStore && w.CookieStore.prototype;
      const fields = ["name", "value", "expires", "path", "sameSite", "partitioned", "maxAge"];
      const changes = ["set", "delete"];
      for (let i = 0; store && i < changes.length; i++) {
        const real = store[changes[i]];
        if (typeof real !== "function") continue;
        const ownHost = function (options) {
          const args = [];
          for (let j = 0; j < arguments.length; j++) args[j] = arguments[j];
          if (options !== null && (typeof options === "object" || typeof options === "function")) {
            const given = { __proto__: null };
            for (let f = 0; f < fields.length; f++) {
              const found = options[fields[f]];
              if (found !== undefined) given[fields[f]] = found;
            }
            args[0] = given;
          }
          return apply(real, this, args);
        };
        define(ownHost, "name", { value: changes[i] });
        define(store, changes[i], { value: ownHost, writable: false, enumerable: true, configurable: false });
      }
      const types = w.trustedTypes;
      if (types && !types.defaultPolicy) {
        try {
          let rules = null;
          const rule = (kind) => (input, type, sink) => {
            if (kind === "createScript" && sink === "Location href") return null;
            if (passing || rules === null || !rules[kind]) return input;
            return apply(rules[kind], undefined, [input, type, sink]);
          };
          const members = ["createHTML", "createScript", "createScriptURL"];
          const create = types.createPolicy;
          const policy = apply(create, types, ["default", { createHTML: rule(members[0]), createScript: rule(members[1]), createScriptURL: rule(members[2]) }]);
          const Mistyped = w.TypeError;
          w.Object.getPrototypeOf(types).createPolicy = function createPolicy(name, options) {
            if (this !== types || rules !== null || text(name) !== "default") return apply(create, this, arguments);
            const given = { createHTML: null, createScript: null, createScriptURL: null };
            for (let i = 0; i < members.length; i++) {
              const found = options ? options[members[i]] : undefined;
              if (found === undefined || found === null) continue;
              if (typeof found !== "function") throw new Mistyped("The policy's " + members[i] + " is not a function");
              given[members[i]] = found;
            }
            rules = given;
            return policy;
          };
        } catch (e) {}
      }
      if (types && w.URL && w.Blob && !describe(w, "ghostlyWorkerGuard")) {
        try {
          define(w, "ghostlyWorkerGuard", { value: true });
          const construct = w.Reflect.construct;
          const json = w.JSON.stringify;
          const later = w.setTimeout;
          const Blob = w.Blob;
          const sized = describe(Blob.prototype, "size").get;
          const make = w.URL.createObjectURL;
          const revoke = w.URL.revokeObjectURL;
          const policy = "if (self.trustedTypes && !self.trustedTypes.defaultPolicy) { try { self.trustedTypes.createPolicy('default', { createHTML: (s) => s, createScript: (s) => s, createScriptURL: (s) => s }); } catch (e) {} }";
          const script = (code) => apply(make, null, [new Blob([code], { type: "text/javascript" })]);
          const known = { __proto__: null };
          let first = null;
          w.URL.createObjectURL = function createObjectURL(object) {
            const made = apply(make, this, arguments);
            try { apply(sized, object, []); known[made] = { blob: object, inner: null, classic: null, module: null }; } catch (e) {}
            return made;
          };
          w.URL.revokeObjectURL = function revokeObjectURL(url) {
            try {
              const key = text(url);
              const entry = known[key];
              if (entry) {
                delete known[key];
                const ours = [entry.inner, entry.classic, entry.module];
                apply(later, w, [() => { for (let i = 0; i < 3; i++) { if (ours[i] !== null) apply(revoke, null, [ours[i]]); } }, 60000]);
              }
            } catch (e) {}
            return apply(revoke, this, arguments);
          };
          const start = (url, options) => {
            const entry = known[text(url)];
            if (!entry) return url;
            const kind = options && typeof options === "object" && options.type === "module" ? "module" : "classic";
            if (entry[kind] === null) {
              if (entry.inner === null) entry.inner = apply(make, null, [entry.blob]);
              if (kind === "module" && first === null) first = script(policy);
              entry[kind] = script(kind === "module" ? "import " + json(first) + "; import " + json(entry.inner) + ";" : policy + " importScripts(" + json(entry.inner) + ");");
            }
            return entry[kind];
          };
          const makers = ["Worker", "SharedWorker"];
          for (let i = 0; i < makers.length; i++) {
            const Real = w[makers[i]];
            if (typeof Real !== "function") continue;
            const started = function (url) {
              if (new.target === undefined) return apply(Real, this, arguments);
              const args = [];
              for (let j = 0; j < arguments.length; j++) args[j] = arguments[j];
              if (args.length > 0) { try { args[0] = start(url, args[1]); } catch (e) {} }
              return construct(Real, args, new.target);
            };
            define(started, "name", { value: makers[i] });
            started.prototype = Real.prototype;
            define(Real.prototype, "constructor", { value: started, writable: true, enumerable: false, configurable: true });
            w[makers[i]] = started;
          }
        } catch (e) {}
      }
      const reopen = proto.open;
      proto.open = function () {
        const got = apply(reopen, this, arguments);
        try { if (apply(view, this, []) === w) apply(listen, this, ["load", sweep, true]); } catch (e) {}
        return got;
      };
      const shadowed = (html) => apply(index, apply(lower, html, []), ["shadowrootmode"]) >= 0;
      const Refused = w.TypeError;
      const refuse = () => { throw new Refused("A declarative shadow root is not allowed here"); };
      const parsers = [[elements, "setHTMLUnsafe"], [w.ShadowRoot && w.ShadowRoot.prototype, "setHTMLUnsafe"], [w.Document, "parseHTMLUnsafe"]];
      for (let i = 0; i < parsers.length; i++) {
        const owner = parsers[i][0];
        const name = parsers[i][1];
        const real = owner && owner[name];
        if (typeof real !== "function") continue;
        owner[name] = function (html) {
          const checked = text(html);
          if (shadowed(checked)) refuse();
          return apply(real, this, arguments.length > 1 ? [checked, arguments[1]] : [checked]);
        };
      }
      let tail = "";
      const writes = ["write", "writeln"];
      for (let i = 0; i < writes.length; i++) {
        const real = proto[writes[i]];
        if (typeof real !== "function") continue;
        proto[writes[i]] = function () {
          let checked = "";
          for (let j = 0; j < arguments.length; j++) checked += text(arguments[j]);
          if (shadowed(tail + checked)) refuse();
          tail = apply(slice, tail + checked, [-16]);
          return apply(real, this, [checked]);
        };
      }
      const kinds = ["HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement", "HTMLEmbedElement"];
      const reads = ["contentWindow", "contentDocument", "getSVGDocument"];
      for (let k = 0; k < kinds.length; k++) {
        const owner = w[kinds[k]] && w[kinds[k]].prototype;
        for (let r = 0; r < reads.length; r++) {
          const name = reads[r];
          const found = owner && describe(owner, name);
          const key = found && found.get ? "get" : "value";
          if (!found || typeof found[key] !== "function") continue;
          const read = found[key];
          found[key] = function () {
            const got = apply(read, this, arguments);
            try { shut(name === "contentWindow" ? got : apply(view, got, [])); } catch (e) {}
            return got;
          };
          try { define(owner, name, found); } catch (e) {}
        }
      }
      const inserts = [
        [w.Node, ["appendChild", "insertBefore", "replaceChild"]],
        [w.Element, ["append", "prepend", "before", "after", "replaceWith", "replaceChildren", "insertAdjacentElement", "insertAdjacentHTML", "setHTMLUnsafe", "setHTML", "innerHTML", "outerHTML"]],
        [w.CharacterData, ["before", "after", "replaceWith"]],
        [w.DocumentType, ["before", "after", "replaceWith"]],
        [w.Document, ["append", "prepend", "replaceChildren", "write", "writeln", "body"]],
        [w.Range, ["insertNode", "surroundContents"]],
        [w.HTMLTableElement, ["caption", "tHead", "tFoot"]],
        [w.HTMLSelectElement, ["add"]],
        [w.HTMLOptionsCollection, ["add"]],
      ];
      for (let k = 0; k < inserts.length; k++) {
        const owner = inserts[k][0] && inserts[k][0].prototype;
        const names = inserts[k][1];
        for (let n = 0; n < names.length; n++) {
          const found = owner && describe(owner, names[n]);
          const key = found && found.set ? "set" : "value";
          if (!found || typeof found[key] !== "function") continue;
          const real = found[key];
          found[key] = function () {
            try { return apply(real, this, arguments); } finally { sweep(); }
          };
          try { define(owner, names[n], found); } catch (e) {}
        }
      }
      const inShadow = w.DocumentFragment.prototype.querySelectorAll;
      if (attachShadow) {
        elements.attachShadow = function () {
          const root = apply(attachShadow, this, arguments);
          try { watch(root, inShadow); } catch (e) {}
          return root;
        };
      }
    }
    if (!watched) watch(home, proto.querySelectorAll);
  } catch (e) {}
})(window)`;

/** `CLIPBOARD_GUARD_SCRIPT`'s hash, as a CSP source: the bridge's policy and a contact's own are given it. */
export const CLIPBOARD_GUARD_HASH = "'sha256-GQzOHQubK9NTonmQhyHQhV2gUnNdff7hJrWBqiB3vlM='";
