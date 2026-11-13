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
 *   (an empty frame's first load fires as it is put in the page) and as the page changes, each `srcdoc` frame gets
 *   this script first, a declarative shadow root the page's script would make is refused, and with `VIEWER_GUARD_CSP`
 *   a `javascript:` URL is refused (its own Trusted Types default policy; one passes every other string on as it is,
 *   or, once the page made its own `default` policy, to that one's rules: the page's `createPolicy("default")` gets the
 *   guard's policy back with them, and the copy of itself it puts in a `srcdoc` frame skips them).
 * A frame's window keeps what was run in it on its first, empty page when the page it loads is of the same origin (the
 * bridge's guard reaches the app's frame then): there this script only watches the new document. Each document it
 * watches is marked (`ghostlyClipboardGuard`, fixed in place): the bridge reads that to know the guard ran in the page
 * it shows. It uses nothing the page can change after it ran (the page's own code runs later, in the same realm).
 *
 * A fence, not a wall, as the WebRTC guard's own: a frame's window read by its index (`window[0]`) before it loads,
 * inside a shadow tree written in the HTML the page itself sends, is out of its sight.
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
    const watched = !!describe(home, "ghostlyClipboardGuard");
    if (!fresh && watched) return;
    if (!watched) define(home, "ghostlyClipboardGuard", { value: true });
    const own = "<script>(" + noClipboardWrites + ")(window)<" + "/script>";
    const close = "<" + "/script>";
    const webRtc = "<script>(function noWebRtc(";
    const text = w.String;
    const lower = text.prototype.toLowerCase;
    const slice = text.prototype.slice;
    const index = text.prototype.indexOf;
    const listen = w.EventTarget.prototype.addEventListener;
    const shut = (inner) => {
      try { if (inner && inner !== w) noClipboardWrites(inner); } catch (e) {}
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
        return apply(run, this, args);
      };
      define(proto, "execCommand", { value: guarded, writable: false, enumerable: exec.enumerable, configurable: false });
      const types = w.trustedTypes;
      if (types && !types.defaultPolicy) {
        try {
          let rules = null;
          const rule = (kind) => (input, type, sink) => {
            if (kind === "createScript" && sink === "Location href") return null;
            if (passing || rules === null) return input;
            return rules[kind] ? apply(rules[kind], undefined, [input, type, sink]) : null;
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
export const CLIPBOARD_GUARD_HASH = "'sha256-ay9kpYD2BIflB8W9w+iAbo1krsFBwIJunUmXTACfhao='";
