import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CLIPBOARD_GUARD_SCRIPT, VIEWER_GUARD_SCRIPT } from "../src/index";

// covers: services.web-open

/**
 * The page guards follow what each change put in the page, not the whole page each time: an app that adds a row per
 * message must not pay for every row it already has. They must still reach every frame and speculation rules script
 * a look over the whole page would, by every way a page can put one in, and with nothing the page can change after
 * they ran.
 *
 * The guards run in a happy-dom page through a window that reads like a browser's where happy-dom's does not: a
 * mutation record's members and a node list's length are getters on their prototypes (happy-dom's are own fields).
 */

type Guard = "clipboard" | "viewer";
const SCRIPTS: Record<Guard, string> = { clipboard: CLIPBOARD_GUARD_SCRIPT, viewer: VIEWER_GUARD_SCRIPT };
const OWN: Record<Guard, string> = {
  clipboard: `<script>${CLIPBOARD_GUARD_SCRIPT}</script>`,
  viewer: `<script>${VIEWER_GUARD_SCRIPT}</script>`,
};

type Happy = InstanceType<typeof Window>;
type Doc = Happy["document"];
type El = ReturnType<Doc["createElement"]>;

/** What the guards change on happy-dom's classes, which all its windows share: put back after each test. */
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});
function kept(...owners: Array<object | undefined>) {
  for (const owner of owners) {
    if (!owner) continue;
    const before = Object.getOwnPropertyDescriptors(owner);
    restores.push(() => {
      for (const key of Reflect.ownKeys(owner)) if (!(key in before)) delete (owner as Record<PropertyKey, unknown>)[key];
      for (const key of Reflect.ownKeys(before)) Object.defineProperty(owner, key, before[key as string]);
    });
  }
}

interface Page {
  win: Happy;
  doc: Doc;
  /** Whole-document looks the guard made (`querySelectorAll` on the document itself). */
  whole: { count: number };
  /** The prototypes a page would change, as the guard's window has them. */
  w: Record<string, unknown>;
  flush(): Promise<void>;
}

/**
 * A page with `guard` run first in it (`both`: the clipboard guard, then the WebRTC guard, as the web runner puts them
 * with Hide my IP on); `browserLike: false` hands it happy-dom's own records (no getters).
 */
function page(guard: Guard, { browserLike = true, both = false } = {}): Page {
  const win = new Window({
    settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableIframePageLoading: true, disableCSSFileLoading: true },
  });
  const doc = win.document;
  const happy = win as unknown as Record<string, { prototype: object } | undefined>;
  kept(
    ...["Node", "Element", "CharacterData", "DocumentType", "Range", "HTMLTableElement", "HTMLSelectElement", "HTMLOptionsCollection",
      "HTMLIFrameElement", "HTMLFrameElement", "HTMLObjectElement", "HTMLEmbedElement", "ShadowRoot", "DocumentFragment"]
      .map((name) => happy[name]?.prototype),
  );
  const proto = win.Document.prototype as unknown as Record<string, unknown>;
  const whole = { count: 0 };
  const all = proto.querySelectorAll as (this: unknown, selector: string) => unknown;
  Object.defineProperty(proto, "querySelectorAll", {
    configurable: true,
    writable: true,
    value: function (this: unknown, selector: string) {
      if (this === doc) whole.count++;
      return all.call(this, selector);
    },
  });
  // The clipboard guard does its full run only where execCommand is the browser's (configurable, not yet guarded).
  Object.defineProperty(proto, "execCommand", { configurable: true, writable: true, value: () => true });

  const w: Record<string, unknown> = {
    Reflect, Object, String, TypeError, WeakSet,
    Document: win.Document,
    Element: win.Element,
    Node: win.Node,
    DocumentFragment: win.DocumentFragment,
    CharacterData: win.CharacterData,
    DocumentType: win.DocumentType,
    Range: win.Range,
    HTMLTableElement: win.HTMLTableElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLIFrameElement: win.HTMLIFrameElement,
    ShadowRoot: win.ShadowRoot,
    Event: class { get eventPhase() { return 0; } },
    EventTarget: { prototype: { addEventListener() {} } },
    document: doc,
  };
  Object.defineProperty(w, "length", { get: () => 0 });
  Object.defineProperty(proto, "defaultView", { configurable: true, get: () => w });

  const Real = win.MutationObserver;
  if (browserLike) {
    const behind = new WeakMap<object, Record<string, unknown>>();
    class MutationRecord {}
    for (const name of ["type", "target", "addedNodes"]) {
      Object.defineProperty(MutationRecord.prototype, name, { configurable: true, get(this: object) { return behind.get(this)![name]; } });
    }
    class NodeList {}
    Object.defineProperty(NodeList.prototype, "length", { configurable: true, get(this: ArrayLike<unknown>) { return this.length; } });
    class MutationObserver {
      #real: InstanceType<typeof Real>;
      constructor(callback: (records: object[], observer: MutationObserver) => void) {
        this.#real = new Real((records) => callback(records.map((record) => {
          const made = Object.create(MutationRecord.prototype) as object;
          behind.set(made, record as unknown as Record<string, unknown>);
          return made;
        }), this));
      }
      observe(target: unknown, options: unknown) {
        this.#real.observe(target as never, options as never);
      }
    }
    Object.assign(w, { MutationRecord, NodeList, MutationObserver });
  } else {
    class NodeList {}
    Object.defineProperty(NodeList.prototype, "length", { configurable: true, get(this: ArrayLike<unknown>) { return this.length; } });
    Object.assign(w, { MutationRecord: win.MutationRecord, NodeList, MutationObserver: Real });
  }
  for (const run of both ? [CLIPBOARD_GUARD_SCRIPT, VIEWER_GUARD_SCRIPT] : [SCRIPTS[guard]]) new Function("window", run)(w);
  return { win, doc, whole, w, flush: () => new Promise((done) => setTimeout(done, 0)) };
}

interface Found {
  getAttribute(name: string): string | null;
  textContent: string | null;
  shadowRoot: Tree | null;
}
interface Tree {
  querySelectorAll(selector: string): ArrayLike<Found>;
}

/** Every open tree of the page: the document and the shadow roots in it, however deep. */
function trees(doc: Doc): Tree[] {
  const found: Tree[] = [doc as unknown as Tree];
  for (let i = 0; i < found.length; i++) {
    for (const element of Array.from(found[i].querySelectorAll("*"))) if (element.shadowRoot) found.push(element.shadowRoot);
  }
  return found;
}

/** The `srcdoc` frames of the page that do not start with the guard, and the speculation rules still in it. */
function missed(doc: Doc, guard: Guard): string[] {
  const left: string[] = [];
  for (const tree of trees(doc)) {
    for (const frame of Array.from(tree.querySelectorAll("iframe[srcdoc]"))) {
      const srcdoc = frame.getAttribute("srcdoc")!;
      if (!srcdoc.startsWith(OWN[guard])) left.push(`frame ${srcdoc.slice(0, 40)}`);
    }
    if (guard !== "viewer") continue;
    for (const script of Array.from(tree.querySelectorAll("script"))) {
      if ((script.getAttribute("type") ?? "").trim().toLowerCase() === "speculationrules") left.push(`rules ${script.textContent}`);
    }
  }
  return left;
}

/** How many `srcdoc` frames the page has, shadow trees included. */
const frames = (doc: Doc) => trees(doc).reduce((sum, tree) => sum + tree.querySelectorAll("iframe[srcdoc]").length, 0);

const frameHtml = (n: number | string) => `<iframe srcdoc="<p>${n}"></iframe>`;
const rulesHtml = (n: number | string) => `<script type="speculationrules">{"n":"${n}"}</script>`;

describe.each(["clipboard", "viewer"] as const)("the %s guard's look at what changed", (guard) => {
  const looks = guard === "viewer" ? 2 : 1;

  it("looks over the whole page once, then only over what each change put in it", async () => {
    const { doc, whole, flush } = page(guard);
    expect(whole.count).toBe(looks);
    const list = doc.createElement("ul");
    doc.body.appendChild(list);
    for (let i = 0; i < 200; i++) {
      const row = doc.createElement("li");
      row.textContent = `message ${i}`;
      if (i % 50 === 0) row.innerHTML = frameHtml(i) + rulesHtml(i);
      list.appendChild(row);
      await flush();
    }
    // One look at the start, however many changes (it was one more for each change).
    expect(whole.count).toBe(looks);
    expect(missed(doc, guard)).toEqual([]);
    expect(doc.querySelectorAll("iframe[srcdoc]").length).toBe(4);
  });

  it("reaches a frame or rules put in by every way a page can, one change at a time and many in one go", async () => {
    const { doc, win, flush } = page(guard);
    let body = doc.body;
    const fresh = () => doc.createElement("div");
    const steps: Array<[string, () => void]> = [
      ["appendChild of a frame", () => { const f = doc.createElement("iframe"); f.setAttribute("srcdoc", "<p>a"); body.appendChild(f); }],
      ["a subtree built away from the page", () => { const d = fresh(); d.innerHTML = `<section><div>${frameHtml("b")}${rulesHtml("b")}</div></section>`; body.append(d); }],
      ["innerHTML", () => { const d = fresh(); body.append(d); d.innerHTML = `<p>${frameHtml("c")}</p>${rulesHtml("c")}`; }],
      ["outerHTML", () => { const d = fresh(); body.append(d); d.outerHTML = `<article>${frameHtml("d")}${rulesHtml("d")}</article>`; }],
      ["insertAdjacentHTML", () => { body.insertAdjacentHTML("beforeend", `<div>${frameHtml("e")}${rulesHtml("e")}</div>`); }],
      ["insertBefore, replaceWith, prepend", () => {
        const a = fresh(); a.innerHTML = frameHtml("f1"); body.insertBefore(a, body.firstChild);
        const b = fresh(); body.append(b); const c = fresh(); c.innerHTML = frameHtml("f2"); b.replaceWith(c);
        const d = fresh(); d.innerHTML = rulesHtml("f3"); body.prepend(d);
      }],
      ["Range.insertNode", () => { const r = doc.createRange(); r.selectNodeContents(body); const d = fresh(); d.innerHTML = frameHtml("g") + rulesHtml("g"); r.insertNode(d); }],
      ["a template's content, cloned in", () => {
        const t = doc.createElement("template"); t.innerHTML = frameHtml("h") + rulesHtml("h"); body.append(t);
        body.append(doc.importNode(t.content, true));
      }],
      ["srcdoc set as an attribute on a frame already in the page", () => { const f = doc.createElement("iframe"); body.append(f); f.setAttribute("srcdoc", "<p>i"); }],
      ["srcdoc set as a property", () => { const f = doc.createElement("iframe"); body.append(f); (f as unknown as { srcdoc: string }).srcdoc = "<p>j"; }],
      ["srcdoc changed on a frame the guard already went into", () => { body.querySelector("iframe")!.setAttribute("srcdoc", "<p>k"); }],
      ["srcdoc set through its Attr", () => { const f = doc.createElement("iframe"); body.append(f); const a = doc.createAttribute("srcdoc"); a.value = "<p>l0"; f.setAttributeNode(a); a.value = "<p>l"; }],
      ["a frame added and its srcdoc set in the same task", () => { const f = doc.createElement("iframe"); body.append(f); f.setAttribute("srcdoc", "<p>m"); body.querySelector("iframe")!.setAttribute("srcdoc", "<p>m2"); }],
      ["a subtree taken out, changed while out, and put back", () => {
        const d = fresh(); d.innerHTML = frameHtml("n0"); body.append(d);
        d.remove(); d.querySelector("iframe")!.setAttribute("srcdoc", "<p>n"); d.insertAdjacentHTML("beforeend", rulesHtml("n")); body.append(d);
      }],
      ["a frame moved within the page", () => { const f = body.querySelector("iframe")!; f.setAttribute("srcdoc", "<p>o"); const d = fresh(); body.prepend(d); d.append(f); }],
      ["nodes added inside a subtree that is then moved", () => {
        const d = fresh(); body.append(d); const inner = fresh(); d.append(inner); inner.innerHTML = frameHtml("p") + rulesHtml("p"); const other = fresh(); body.append(other); other.append(d);
      }],
      ["added and removed in the same task", () => { const d = fresh(); d.innerHTML = frameHtml("q") + rulesHtml("q"); body.append(d); d.remove(); body.append(d); }],
      ["a shadow root the page makes", () => {
        const host = fresh(); body.append(host); const root = host.attachShadow({ mode: "open" });
        root.innerHTML = `<div>${frameHtml("s")}${rulesHtml("s")}</div>`;
        const later = fresh(); later.innerHTML = frameHtml("s2"); root.append(later);
      }],
      ["a frame in a shadow root moved into the page", () => {
        const root = (body.querySelector("div[id=shadow-host]") ?? (() => { const h = fresh(); h.id = "shadow-host"; body.append(h); h.attachShadow({ mode: "open" }); return h; })()).shadowRoot!;
        root.innerHTML = frameHtml("t0"); const f = root.querySelector("iframe")!; f.setAttribute("srcdoc", "<p>t"); body.append(f);
      }],
      ["a speculation rules script given its type in the page", () => {
        const s = doc.createElement("script"); s.setAttribute("type", "text/plain"); s.textContent = "{}"; body.append(s);
        s.setAttribute("type", "speculationrules");
      }],
      ["a speculation rules script by its type property", () => { const s = doc.createElement("script"); body.append(s); (s as unknown as { type: string }).type = "speculationrules"; }],
      ["text put in a speculation rules script", () => {
        const s = doc.createElement("script"); s.setAttribute("type", "text/plain"); body.append(s);
        s.setAttribute("type", " SpeculationRules "); s.append(doc.createTextNode("{}"));
      }],
    ];
    // A page that writes itself anew (after its load, document.write opens a new one): first, as it drops the rest.
    doc.write(`<div>${frameHtml("r")}${rulesHtml("r")}</div>`);
    await flush();
    expect(missed(doc, guard)).toEqual([]);
    expect(frames(doc)).toBe(1);
    body = doc.body;
    for (const [, step] of steps) {
      step();
      await flush();
      expect(missed(doc, guard)).toEqual([]);
    }
    // All of them again, in one task: one batch of records.
    for (const [, step] of steps) step();
    await flush();
    expect(missed(doc, guard)).toEqual([]);
    expect(frames(doc)).toBeGreaterThan(20);
    await win.happyDOM.close();
  });

  it("reaches a frame given its srcdoc, or a script given its type, in a later task than the one that put it in", async () => {
    const { doc, flush } = page(guard);
    const later: Array<[El, (element: El) => void]> = [
      [doc.createElement("iframe"), (f) => f.setAttribute("srcdoc", "<p>attribute")],
      [doc.createElement("iframe"), (f) => { (f as unknown as { srcdoc: string }).srcdoc = "<p>property"; }],
      [doc.createElement("script"), (s) => s.setAttribute("type", "speculationrules")],
      [doc.createElement("script"), (s) => { (s as unknown as { type: string }).type = " SPECULATIONRULES"; }],
    ];
    for (const [element, change] of later) {
      if (element.localName === "script") element.setAttribute("type", "text/plain");
      doc.body.append(element);
      await flush();
      change(element);
      await flush();
      expect(missed(doc, guard)).toEqual([]);
    }
    // Text put later in a script whose type was changed even later still: the browser reads its rules then.
    const s = doc.createElement("script");
    s.setAttribute("type", "text/plain");
    doc.body.append(s);
    await flush();
    s.setAttribute("type", "speculationrules");
    s.append(doc.createTextNode("{}"));
    await flush();
    expect(missed(doc, guard)).toEqual([]);
  });

  it("misses nothing a look over the whole page would find, whatever the page does (random changes)", async () => {
    const { doc, flush } = page(guard);
    let seed = 8531;
    const random = (n: number) => {
      // mulberry32: the same changes on every run.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * n | 0;
    };
    const pick = <T>(items: T[]): T | undefined => (items.length === 0 ? undefined : items[random(items.length)]);
    const out: El[] = [];
    const placed = () => Array.from(doc.body.querySelectorAll("div, section, iframe, script")) as El[];
    const containers = () => [doc.body as El, ...Array.from(doc.body.querySelectorAll("div, section")) as El[]];
    const snippets = [frameHtml("x"), rulesHtml("x"), `<div>${frameHtml("y")}</div>`, `<section><div>${rulesHtml("z")}<iframe></iframe></div></section>`, "<p>text</p>", "<iframe></iframe>"];
    const ops: Array<() => void> = [
      () => { const d = doc.createElement(pick(["div", "section"])!); d.innerHTML = pick(snippets)!; out.push(d); },
      () => { const d = pick(out); if (d) pick(containers())!.append(d); },
      () => { const d = pick(out); if (d) d.insertAdjacentHTML("beforeend", pick(snippets)!); },
      () => { const e = pick(placed()); const to = pick(containers()); if (e && to && !e.contains(to)) to.append(e); },
      () => { const e = pick(placed()); if (e) { e.remove(); out.push(e); } },
      () => { const f = pick(Array.from(doc.querySelectorAll("iframe")) as El[]); if (f) f.setAttribute("srcdoc", `<p>${random(100)}`); },
      () => { const f = pick(out.flatMap((d) => Array.from(d.querySelectorAll("iframe")) as El[])); if (f) (f as unknown as { srcdoc: string }).srcdoc = `<p>${random(100)}`; },
      () => { const f = pick(Array.from(doc.querySelectorAll("iframe")) as El[]); if (f) f.removeAttribute("srcdoc"); },
      () => { const s = pick(Array.from(doc.querySelectorAll("script")) as El[]); if (s) s.setAttribute("type", "speculationrules"); },
      () => { const c = pick(containers()); if (c && c !== (doc.body as El)) c.innerHTML = pick(snippets)!; },
      () => { const c = pick(containers()); if (c && c !== (doc.body as El)) c.outerHTML = `<div>${pick(snippets)!}</div>`; },
      () => { const c = pick(containers()); if (c) c.insertAdjacentHTML(pick(["beforeend", "afterbegin"] as const)!, pick(snippets)!); },
      () => { const c = pick(containers()); if (c && c !== (doc.body as El) && !c.shadowRoot) { c.attachShadow({ mode: "open" }).innerHTML = pick(snippets)!; } },
      () => { const host = pick(containers().filter((c) => c.shadowRoot)); if (host) host.shadowRoot!.append(Object.assign(doc.createElement("div"), { innerHTML: pick(snippets)! })); },
    ];
    let went = 0;
    for (let batch = 0; batch < 300; batch++) {
      for (let n = 1 + random(6); n > 0; n--) {
        try {
          pick(ops)!();
        } catch {
          // happy-dom refuses a few of them (a shadow root on an element that cannot hold one): the next one runs.
        }
      }
      await flush();
      expect(missed(doc, guard), `batch ${batch}`).toEqual([]);
      went += frames(doc);
    }
    // Frames in the page, summed over the batches: the changes did put many in.
    expect(went).toBeGreaterThan(300);
  });

  it("is not led astray by a page that changes the records, node lists and elements after it ran", async () => {
    const { doc, whole, w, flush } = page(guard);
    const element = (w.Element as { prototype: object }).prototype;
    const node = (w.Node as { prototype: object }).prototype;
    kept(element, node);
    const record = (w.MutationRecord as { prototype: object }).prototype;
    const list = (w.NodeList as { prototype: object }).prototype;
    // The page's own code, run after the guard: every member the guard reads a change by now lies.
    for (const name of ["type", "target", "addedNodes"]) {
      Object.defineProperty(record, name, { configurable: true, get: () => (name === "type" ? "characterData" : name === "target" ? doc : []) });
    }
    Object.defineProperty(list, "length", { configurable: true, get: () => 0 });
    Object.defineProperty(element, "matches", { configurable: true, writable: true, value: () => false });
    Object.defineProperty(element, "querySelectorAll", { configurable: true, writable: true, value: () => [] });
    Object.defineProperty(node, "nodeType", { configurable: true, get: () => 3 });
    const d = doc.createElement("div");
    d.innerHTML = `<div>${frameHtml("tampered")}${rulesHtml("tampered")}</div>`;
    doc.body.append(d);
    await flush();
    const own = doc.createElement("iframe");
    own.setAttribute("srcdoc", "<p>itself");
    doc.body.append(own);
    const rules = doc.createElement("script");
    rules.setAttribute("type", "speculationrules");
    doc.body.append(rules);
    await flush();
    const f = doc.createElement("iframe");
    doc.body.append(f);
    await flush();
    f.setAttribute("srcdoc", "<p>later");
    await flush();
    // Put back before reading, so the check is happy-dom's own.
    while (restores.length > 0) restores.pop()!();
    expect(missed(doc, guard)).toEqual([]);
    expect(f.getAttribute("srcdoc")!.startsWith(OWN[guard])).toBe(true);
    // And it did so piece by piece, as before the page changed anything.
    expect(whole.count).toBe(looks);
  });

  it("looks over the whole page at each change where it cannot read the records piece by piece", async () => {
    const { doc, whole, flush } = page(guard, { browserLike: false });
    for (let i = 0; i < 5; i++) {
      const d = doc.createElement("div");
      d.innerHTML = frameHtml(i) + rulesHtml(i);
      doc.body.append(d);
      await flush();
    }
    expect(missed(doc, guard)).toEqual([]);
    // The look at the start, then two per change: the change, and the guard's own srcdoc it set.
    expect(whole.count).toBe(looks * (1 + 2 * 5));
  });
});

describe("both guards in one page (the web with Hide my IP on)", () => {
  it("each puts itself first in every srcdoc frame once, and they leave each other's copy be", async () => {
    const { doc, whole, flush } = page("viewer", { both: true });
    const list = doc.createElement("ul");
    doc.body.append(list);
    for (let i = 0; i < 20; i++) {
      const row = doc.createElement("li");
      row.innerHTML = i % 5 === 0 ? frameHtml(i) + rulesHtml(i) : `message ${i}`;
      list.append(row);
      await flush();
    }
    const frame = doc.querySelector("iframe")!;
    frame.setAttribute("srcdoc", "<p>again");
    await flush();
    expect(missed(doc, "viewer")).toEqual([]);
    for (const f of Array.from(doc.querySelectorAll("iframe[srcdoc]"))) {
      expect(f.getAttribute("srcdoc")!.split(OWN.viewer).length).toBe(2);
      expect(f.getAttribute("srcdoc")!.split(OWN.clipboard).length).toBe(2);
    }
    expect(frame.getAttribute("srcdoc")).toBe(`${OWN.viewer}${OWN.clipboard}<p>again`);
    // One look each at the start (the WebRTC guard's two), none after.
    expect(whole.count).toBe(3);
  });
});

/** Like the clipboard guard's (its "look over the frames" test): a frame of another origin is passed by, untouched. */
describe("the WebRTC guard's look over the frames", () => {
  function realm(frames: unknown[] = []) {
    class Doc {}
    const w: Record<string, unknown> = {
      Document: Doc,
      Element: { prototype: {} },
      DocumentFragment: { prototype: {} },
      NodeList: { prototype: { get length() { return 0; } } },
      MutationObserver: class { observe() {} },
      EventTarget: { prototype: { addEventListener() {} } },
      RTCPeerConnection: class {},
      document: null,
    };
    Object.defineProperty(w, "length", { get() { return frames.length; } });
    frames.forEach((frame, i) => { w[i] = frame; });
    Object.defineProperty(Doc.prototype, "defaultView", { get() { return w; } });
    w.document = new Doc();
    return w;
  }

  it("leaves a frame of another origin untouched, and still runs in the page's own frames", () => {
    let touched = 0;
    const other = new Proxy(Object.create(null) as object, {
      getPrototypeOf: () => null,
      has() { touched++; throw new Error("SecurityError"); },
      get() { touched++; throw new Error("SecurityError"); },
    });
    const before = realm();
    const after = realm();
    const page = realm([before, other, after]);
    new Function("window", VIEWER_GUARD_SCRIPT)(page);
    expect(touched).toBe(0);
    expect("RTCPeerConnection" in page).toBe(false);
    expect("RTCPeerConnection" in before).toBe(false);
    expect("RTCPeerConnection" in after).toBe(false);
  });
});
