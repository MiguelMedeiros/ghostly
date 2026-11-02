import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stylesheetsFirst } from "../../../../web/firstPaint";

// covers: app.boot

/*
 * The boot guard (apps/web/public/boot-guard.js): the plain script that speaks when the app never draws. Run here
 * as the page runs it, a classic script before the bundle, against a document with an empty #root.
 */

const REPO = join(import.meta.dirname, "..", "..", "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "apps/web/public/boot-guard.js"), "utf8");
/** The page the guard runs in: its #root holds the first paint (#boot-shell) until the app draws. */
const PAGE = new DOMParser().parseFromString(readFileSync(join(REPO, "apps/web/index.html"), "utf8"), "text/html");
const FIRST_PAINT = PAGE.getElementById("root")!.innerHTML;
const OLD_WEBVIEW = "Mozilla/5.0 (Linux; Android 9; SM-G960F; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/92.0.4515.159 Mobile Safari/537.36";
const NEW_ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const OLD_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 15_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.3 Mobile/15E148 Safari/604.1";

interface Guard { details(): string; clean(text: string): string }
const guard = () => (window as unknown as { __ghostlyBoot: Guard }).__ghostlyBoot;
const panel = () => document.getElementById("boot-fallback");

function start({ agent = NEW_ANDROID, language = "en-US", languages = [language], loaded = true, root = "" }: { agent?: string; language?: string; languages?: string[]; loaded?: boolean; root?: string } = {}) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
  vi.spyOn(navigator, "language", "get").mockReturnValue(language);
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
  vi.spyOn(document, "readyState", "get").mockReturnValue(loaded ? "complete" : "loading");
  document.body.innerHTML = `<div id="root">${root}</div>`;
  // The guard listens for as long as the page lives: a test takes its listeners away with the page.
  const listen = window.addEventListener.bind(window);
  const spy = vi.spyOn(window, "addEventListener").mockImplementation((...args: Parameters<typeof window.addEventListener>) => { listening.push(args); listen(...args); });
  new Function(SOURCE)();
  spy.mockRestore();
}
const listening: Parameters<typeof window.addEventListener>[] = [];

function fail(message: string, name = "TypeError") {
  const error = new Error(message);
  error.name = name;
  window.dispatchEvent(new ErrorEvent("error", { error, message, filename: "https://app.example/assets/main-abc.js?v=1", lineno: 3, colno: 9 }));
}

const draw = () => { document.getElementById("root")!.appendChild(document.createElement("div")); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  // What the guard set up goes with it: a drawn root takes its panel and timers, then its listeners and the page.
  if (document.getElementById("root")) { draw(); vi.advanceTimersByTime(2000); }
  for (const args of listening.splice(0)) window.removeEventListener(...args);
  vi.useRealTimers();
  document.body.innerHTML = "";
  delete (window as unknown as { __ghostlyBoot?: Guard }).__ghostlyBoot;
});

describe("the boot guard", () => {
  it("is written for old engines: no arrow functions, let, const, classes, template strings or optional chaining", () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/=>|\blet\s|\bconst\s|\bclass\s|`|\?\.|\?\?|\basync\s|\bawait\s/);
  });

  it("says Ghostly could not start when an error comes before the first render, and names the error", () => {
    start();
    fail("Cannot read properties of undefined (reading 'request')");
    // Not at once: an error the app survives is followed by its first screen.
    expect(panel()).toBeNull();
    vi.advanceTimersByTime(1500);
    expect(panel()).toHaveAttribute("data-reason", "error");
    expect(panel()).toHaveAttribute("role", "alert");
    expect(panel()).toHaveTextContent("Ghostly could not start");
    expect(panel()).toHaveTextContent("Update your browser, or open Ghostly in another one.");
    const details = panel()!.querySelector("textarea")!.value;
    expect(details).toContain("reason: error");
    expect(details).toContain("error: TypeError: Cannot read properties of undefined (reading 'request') (main-abc.js:3:9)");
    expect(details).toContain(`browser: ${NEW_ANDROID}`);
    expect(details).toMatch(/features: .*locks=(yes|no)/);
  });

  it("stays away when the app draws after an error it survived", () => {
    start();
    fail("a registration was refused");
    draw();
    vi.advanceTimersByTime(10_000);
    expect(panel()).toBeNull();
  });

  it("hears a rejected promise and a script that did not load", () => {
    start();
    const rejection = new Event("unhandledrejection") as Event & { reason?: unknown };
    rejection.reason = Object.assign(new Error("blocked by the browser"), { name: "CompileError" });
    window.dispatchEvent(rejection);
    const script = document.createElement("script");
    script.src = "https://app.example/assets/main-abc.js";
    document.body.appendChild(script);
    script.dispatchEvent(new Event("error"));
    vi.advanceTimersByTime(1500);
    const details = panel()!.querySelector("textarea")!.value;
    expect(details).toContain("error: CompileError: blocked by the browser");
    expect(details).toContain("error: script did not load: main-abc.js");
  });

  it("does not take a picture that failed to load for the app failing", () => {
    start({ loaded: false });
    const image = document.createElement("img");
    document.body.appendChild(image);
    image.dispatchEvent(new Event("error"));
    vi.advanceTimersByTime(5000);
    expect(panel()).toBeNull();
  });

  it("says it is taking long when the page has loaded and stays empty, and leaves once the app draws", () => {
    start({ loaded: false });
    vi.advanceTimersByTime(60_000);
    // The bundle is still on its way: the wait starts at the page's load, never before.
    expect(panel()).toBeNull();
    window.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(5900);
    expect(panel()).toBeNull();
    vi.advanceTimersByTime(200);
    expect(panel()).toHaveAttribute("data-reason", "timeout");
    expect(panel()).toHaveTextContent("Ghostly is taking long to start");
    draw();
    vi.advanceTimersByTime(600);
    expect(panel()).toBeNull();
    // A later error with the app still on screen is the app's own error screen's business.
    fail("later");
    vi.advanceTimersByTime(5000);
    expect(panel()).toBeNull();
  });

  it("says Ghostly could not start when the \"open in another tab\" screen drew and the app then failed to", () => {
    start();
    // The lock was slow: the entry drew the waiting screen, then got the lock and the app threw on its first render.
    draw();
    vi.advanceTimersByTime(600);
    document.getElementById("root")!.replaceChildren();
    fail("window.matchMedia is not a function");
    expect(panel()).toBeNull();
    vi.advanceTimersByTime(1500);
    expect(panel()).toHaveAttribute("data-reason", "error");
    expect(panel()).toHaveTextContent("Ghostly could not start");
    expect(panel()!.querySelector("textarea")!.value).toContain("error: TypeError: window.matchMedia is not a function");
  });

  it("hears the error that comes just before the page is emptied", () => {
    start();
    draw();
    vi.advanceTimersByTime(600);
    fail("thrown while the first screen was still there");
    document.getElementById("root")!.replaceChildren();
    vi.advanceTimersByTime(1500);
    expect(panel()).toHaveAttribute("data-reason", "error");
  });

  it("forgets an error the app stayed on screen through", () => {
    start();
    draw();
    vi.advanceTimersByTime(600);
    fail("an old one, survived");
    vi.advanceTimersByTime(60_000);
    document.getElementById("root")!.replaceChildren();
    fail("the one that emptied the page");
    vi.advanceTimersByTime(1500);
    const details = panel()!.querySelector("textarea")!.value;
    expect(details).toContain("the one that emptied the page");
    expect(details).not.toContain("an old one, survived");
  });

  it("leaves again when the app draws over it", () => {
    start();
    draw();
    vi.advanceTimersByTime(600);
    document.getElementById("root")!.replaceChildren();
    fail("x");
    vi.advanceTimersByTime(1500);
    expect(panel()).not.toBeNull();
    draw();
    vi.advanceTimersByTime(600);
    expect(panel()).toBeNull();
  });

  it("does not cover the app, or the \"open in another tab\" screen, drawn before the wait ends", () => {
    start();
    vi.advanceTimersByTime(150);
    draw();
    vi.advanceTimersByTime(20_000);
    expect(panel()).toBeNull();
  });

  it("names the update that helps: Android System WebView on an old WebView, iOS on an old iPhone, neither on a current browser", () => {
    start({ agent: OLD_WEBVIEW });
    fail("Object.hasOwn is not a function");
    vi.advanceTimersByTime(1500);
    expect(panel()!.querySelector('[data-testid="boot-fallback-hint"]')).toHaveTextContent("On Android, update Android System WebView and Chrome in Google Play.");
    draw(); vi.advanceTimersByTime(1000);

    start({ agent: OLD_IPHONE });
    fail("Object.hasOwn is not a function");
    vi.advanceTimersByTime(1500);
    expect(panel()!.querySelector('[data-testid="boot-fallback-hint"]')).toHaveTextContent("On iPhone or iPad, update iOS.");
    draw(); vi.advanceTimersByTime(1000);

    start({ agent: NEW_ANDROID });
    fail("something else");
    vi.advanceTimersByTime(1500);
    expect(panel()).not.toBeNull();
    expect(panel()!.querySelector('[data-testid="boot-fallback-hint"]')).toBeNull();
  });

  it("speaks the browser's language, right to left for Arabic, and English for one it does not know", () => {
    start({ language: "ar-EG" });
    fail("x");
    vi.advanceTimersByTime(1500);
    expect(panel()).toHaveAttribute("lang", "ar");
    expect(panel()).toHaveAttribute("dir", "rtl");
    expect(panel()).toHaveTextContent("تعذّر تشغيل Ghostly");
    draw(); vi.advanceTimersByTime(1000);

    start({ language: "de-DE" });
    fail("x");
    vi.advanceTimersByTime(1500);
    expect(panel()).toHaveAttribute("lang", "en");
    expect(panel()).toHaveTextContent("Ghostly could not start");
  });

  it("draws a first paint from the page alone: \"Starting Ghostly…\" as a status in #root, no inline script, styles the web's policy allows", () => {
    const shell = PAGE.querySelector("#root > #boot-shell")!;
    expect(shell).not.toBeNull();
    expect(shell.getAttribute("role")).toBe("status");
    expect(shell.textContent).toBe("Starting Ghostly…");
    expect(shell.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    // React's first render replaces it: it is the only thing in #root.
    expect(PAGE.getElementById("root")!.childElementCount).toBe(1);
    // script-src 'self': every script of the page is a file; the shell's look is an inline <style>, which needs 'unsafe-inline'.
    for (const script of PAGE.querySelectorAll("script")) expect(script.getAttribute("src"), script.outerHTML).toBeTruthy();
    expect(PAGE.querySelector("style")!.textContent).toContain("#boot-shell");
    const policy = /Content-Security-Policy "([^"]+)"/.exec(readFileSync(join(REPO, "apps/web/nginx-headers.conf"), "utf8"))![1]!;
    expect(/(?:^|;)\s*style-src ([^;]*)/.exec(policy)![1]).toContain("'unsafe-inline'");
  });

  it("puts the built page's stylesheets ahead of its scripts: the first paint waits for every one of them", () => {
    // What Vite writes: the entry script, its preloads, then the stylesheets.
    const built = [
      "<head>",
      '    <script src="/boot-guard.js"></script>',
      '    <script type="module" crossorigin src="/assets/main-a.js"></script>',
      '    <link rel="modulepreload" crossorigin href="/assets/src-b.js">',
      '    <link rel="stylesheet" crossorigin href="/assets/arrows-c.css">',
      '    <link rel="stylesheet" crossorigin href="/assets/main-d.css">',
      '    <meta name="ghostly-build" content="1.7.3 abc">',
      "</head>",
    ].join("\n");
    expect(stylesheetsFirst(built).split("\n")).toEqual([
      "<head>",
      '    <script src="/boot-guard.js"></script>',
      '    <link rel="stylesheet" crossorigin href="/assets/arrows-c.css">',
      '    <link rel="stylesheet" crossorigin href="/assets/main-d.css">',
      '    <script type="module" crossorigin src="/assets/main-a.js"></script>',
      '    <link rel="modulepreload" crossorigin href="/assets/src-b.js">',
      '    <meta name="ghostly-build" content="1.7.3 abc">',
      "</head>",
    ]);
    // Already first, or nothing to move: unchanged.
    expect(stylesheetsFirst(stylesheetsFirst(built))).toBe(stylesheetsFirst(built));
    expect(stylesheetsFirst(readFileSync(join(REPO, "apps/web/index.html"), "utf8"))).toBe(readFileSync(join(REPO, "apps/web/index.html"), "utf8"));
  });

  it("takes the first paint for an empty page: it still says the app is taking long, or could not start", () => {
    start({ loaded: false, root: FIRST_PAINT });
    window.dispatchEvent(new Event("load"));
    vi.advanceTimersByTime(6100);
    expect(panel()).toHaveAttribute("data-reason", "timeout");
    fail("Object.hasOwn is not a function");
    vi.advanceTimersByTime(1500);
    expect(panel()!.querySelector("textarea")!.value).toContain("error: TypeError: Object.hasOwn is not a function");
    // The app's first render takes the first paint's place: the guard leaves.
    document.getElementById("root")!.replaceChildren(document.createElement("main"));
    vi.advanceTimersByTime(600);
    expect(panel()).toBeNull();

    start({ root: FIRST_PAINT });
    fail("window.matchMedia is not a function");
    vi.advanceTimersByTime(1500);
    expect(panel()).toHaveAttribute("data-reason", "error");
  });

  it("gives the first paint the browser's language once the page is read, right to left for Arabic", () => {
    start({ loaded: false, language: "ar-EG", root: FIRST_PAINT });
    const shell = document.getElementById("boot-shell")!;
    document.dispatchEvent(new Event("readystatechange"));
    expect(shell).toHaveAttribute("lang", "ar");
    expect(shell).toHaveAttribute("dir", "rtl");
    expect(shell).toHaveTextContent("جارٍ تشغيل Ghostly…");
    expect(shell.querySelector("svg")).not.toBeNull();
    draw(); vi.advanceTimersByTime(1000);

    start({ language: "pt-BR", root: FIRST_PAINT });
    expect(document.getElementById("boot-shell")).toHaveTextContent("Iniciando o Ghostly…");
    expect(document.getElementById("boot-shell")).toHaveAttribute("dir", "ltr");
  });

  it("speaks the language the profile saved, over the browser's, in the first paint and the panel", () => {
    const registry = JSON.stringify({ version: 1, active: "abcdefghij", profiles: [{ id: "", name: "Personal" }, { id: "abcdefghij", name: "Work" }] });
    try {
      localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "pt" }));
      start({ language: "en-US", root: FIRST_PAINT });
      expect(document.getElementById("boot-shell")).toHaveTextContent("Iniciando o Ghostly…");
      fail("x");
      vi.advanceTimersByTime(1500);
      expect(panel()).toHaveAttribute("lang", "pt");
      expect(panel()).toHaveTextContent("O Ghostly não conseguiu iniciar");
      draw(); vi.advanceTimersByTime(1000);

      // An English profile on an Arabic browser: English, left to right.
      localStorage.setItem("ghostly_app_settings", JSON.stringify({ language: "en" }));
      start({ language: "ar-EG", root: FIRST_PAINT });
      expect(document.getElementById("boot-shell")).toHaveTextContent("Starting Ghostly…");
      expect(document.getElementById("boot-shell")).toHaveAttribute("dir", "ltr");
      draw(); vi.advanceTimersByTime(1000);

      // The profile the page starts as, not the default one: Arabic, right to left.
      localStorage.setItem("ghostly_profiles", registry);
      localStorage.setItem("ghostly_abcdefghij_app_settings", JSON.stringify({ language: "ar" }));
      start({ language: "en-US", root: FIRST_PAINT });
      expect(document.getElementById("boot-shell")).toHaveAttribute("dir", "rtl");
      expect(document.getElementById("boot-shell")).toHaveTextContent("جارٍ تشغيل Ghostly…");
    } finally {
      localStorage.clear();
    }
  });

  it("picks a new profile's language from the browser's list as the app does, also where storage cannot be read", () => {
    start({ language: "de-DE", languages: ["de-DE", "ja-JP"], root: FIRST_PAINT });
    expect(document.getElementById("boot-shell")).toHaveTextContent("Ghostly を起動しています…");
    draw(); vi.advanceTimersByTime(1000);

    const blocked = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    start({ language: "de-DE", languages: ["de-DE", "pt-BR"], root: FIRST_PAINT });
    blocked.mockRestore();
    expect(document.getElementById("boot-shell")).toHaveTextContent("Iniciando o Ghostly…");
  });

  it("has every string in all eight languages, without em dashes", () => {
    const table = /var TEXT = (\{[\s\S]*?\n {2}\});/.exec(SOURCE)![1];
    const text = new Function(`return ${table};`)() as Record<string, Record<string, string>>;
    expect(Object.keys(text).sort()).toEqual(["ar", "en", "es", "fr", "it", "ja", "pt", "zh"]);
    for (const strings of Object.values(text)) {
      expect(Object.keys(strings).sort()).toEqual(Object.keys(text.en).sort());
      for (const value of Object.values(strings)) { expect(value).not.toBe(""); expect(value).not.toContain("—"); }
    }
  });

  it("keeps invites, key-like runs and address fragments out of the details", () => {
    start();
    location.hash = "#/chat/keys-in-the-address";
    const clean = guard().clean("failed at https://app.example/page?token=abc#ghostly1qqqsecret with ghostly1pqrs0tuv9 and 0123456789abcdef0123456789abcdef0123456789abcdef");
    expect(clean).toBe("failed at https://app.example/page with [removed] and [removed]");
    expect(guard().clean("x".repeat(30) + " " + "word ".repeat(400)).length).toBeLessThanOrEqual(600);
    expect(guard().details()).not.toContain("keys-in-the-address");
    location.hash = "";
  });

  it("copies the details, and selects them where the clipboard refuses", async () => {
    vi.useRealTimers();
    start();
    const written: string[] = [];
    vi.stubGlobal("navigator", Object.create(navigator, { clipboard: { value: { writeText: (text: string) => { written.push(text); return Promise.resolve(); } } } }));
    try {
      fail("x");
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const copy = panel()!.querySelector<HTMLButtonElement>('[data-testid="boot-fallback-copy"]')!;
      copy.click();
      await Promise.resolve();
      expect(written[0]).toContain("Ghostly boot report");
      expect(copy).toHaveTextContent("Copied");
    } finally {
      vi.unstubAllGlobals();
      vi.useFakeTimers();
    }
  });
});

describe("the boot guard's theme", () => {
  /*
   * The page's first frames are drawn before React sets the theme (ThemeContext): without the person's scheme and
   * colour theme on <html> by then, index.css's bare :root (Classic dark) styled them, and a light theme flashed dark.
   */
  const html = document.documentElement;
  const themeColor = () => document.head.querySelector('meta[name="theme-color"]')!.getAttribute("content");

  function open({ saved = {} as Record<string, string | undefined>, osDark = false } = {}) {
    document.head.innerHTML = '<meta name="theme-color" content="#202c33">';
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) localStorage.setItem(key, value);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(prefers-color-scheme: dark)" && osDark }));
    start({ loaded: false });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.head.innerHTML = "";
    html.removeAttribute("data-theme");
    html.removeAttribute("data-color-theme");
    html.style.colorScheme = "";
  });

  it("puts the saved scheme and colour theme on <html>, and the browser's bar in its header colour, before the app runs", () => {
    open({ saved: { ghostly_app_settings: JSON.stringify({ colorScheme: "light", colorTheme: "cyan" }) } });
    expect(html).toHaveAttribute("data-theme", "light");
    expect(html).toHaveAttribute("data-color-theme", "cyan");
    expect(html.style.colorScheme).toBe("light");
    expect(themeColor()).toBe("#ecfeff");
  });

  it("follows the system's scheme for System, and an old profile's `theme`", () => {
    open({ saved: { ghostly_app_settings: JSON.stringify({ colorScheme: "system", colorTheme: "purple" }) } });
    expect(html).toHaveAttribute("data-theme", "light");
    expect(themeColor()).toBe("#faf5ff");
    open({ saved: { ghostly_app_settings: JSON.stringify({ colorScheme: "system", colorTheme: "purple" }) }, osDark: true });
    expect(html).toHaveAttribute("data-theme", "dark");
    expect(themeColor()).toBe("#1a1625");
    open({ saved: { ghostly_app_settings: JSON.stringify({ theme: "light" }) } });
    expect(html).toHaveAttribute("data-theme", "light");
    expect(html).toHaveAttribute("data-color-theme", "cyan");
  });

  it("gives a new profile, or settings it cannot read, the app's defaults: dark and cyan", () => {
    open();
    expect(html).toHaveAttribute("data-theme", "dark");
    expect(html).toHaveAttribute("data-color-theme", "cyan");
    expect(themeColor()).toBe("#0c1929");
    open({ saved: { ghostly_app_settings: "{not json" } });
    expect(html).toHaveAttribute("data-theme", "dark");
    open({ saved: { ghostly_app_settings: JSON.stringify({ colorScheme: "sepia", colorTheme: "orange" }) } });
    expect(html).toHaveAttribute("data-theme", "dark");
    expect(html).toHaveAttribute("data-color-theme", "cyan");
  });

  it("reads the settings of the profile the page will start as, and of the space a handoff moved it to", () => {
    const light = JSON.stringify({ colorScheme: "light", colorTheme: "monochrome" });
    const registry = (active: string, space?: string) => JSON.stringify({ version: 1, active, profiles: [{ id: "", name: "Personal" }, { id: "abcdefghij", name: "Work", space }] });
    open({ saved: { ghostly_profiles: registry("abcdefghij"), ghostly_abcdefghij_app_settings: light } });
    expect(html).toHaveAttribute("data-theme", "light");
    expect(html).toHaveAttribute("data-color-theme", "monochrome");
    open({ saved: { ghostly_profiles: registry("abcdefghij", "moved-1"), ghostly_abcdefghij_app_settings: undefined, "ghostly_moved-1_app_settings": light } });
    expect(html).toHaveAttribute("data-theme", "light");
    // A choice the registry does not list is the default profile, as the app reads it.
    open({ saved: { ghostly_profiles: registry("zzzzzzzzzz"), ghostly_app_settings: JSON.stringify({ colorScheme: "light", colorTheme: "classic" }) } });
    expect(html).toHaveAttribute("data-color-theme", "classic");
  });

  it("names each theme's header colour as index.css does", () => {
    const css = readFileSync(join(REPO, "apps/ui/src/index.css"), "utf8");
    for (const scheme of ["dark", "light"]) {
      for (const theme of ["classic", "monochrome", "cyan", "purple"]) {
        const header = new RegExp(`\\[data-theme="${scheme}"\\]\\[data-color-theme="${theme}"\\][^{]*\\{[^}]*--theme-panel-header: (#[0-9a-f]+);`).exec(css)![1];
        open({ saved: { ghostly_app_settings: JSON.stringify({ colorScheme: scheme, colorTheme: theme }) } });
        expect(themeColor(), `${scheme} ${theme}`).toBe(header);
      }
    }
  });
});

describe("the boot guard's language file", () => {
  // As the build names them in the page (apps/web/localePreload.ts): every language but English, which is in the entry.
  const FILES = { ar: "/assets/ar-abc.js", ja: "/assets/ja-def.js", pt: "/assets/pt-ghi.js" };
  const preloads = () => [...document.head.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map((link) => link.getAttribute("href"));

  function open(languages: string[], { files = FILES as Record<string, string> | null, saved = undefined as string | undefined } = {}) {
    if (files) {
      const meta = document.createElement("meta");
      meta.name = "ghostly-locales";
      meta.content = JSON.stringify(files);
      document.head.appendChild(meta);
    }
    if (saved !== undefined) localStorage.setItem("ghostly_app_settings", saved);
    start({ language: languages[0], languages });
  }

  afterEach(() => {
    document.head.innerHTML = "";
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("asks for a new profile's language file as it runs, before the bundle has run, with the module's credentials", () => {
    open(["ar-EG", "en-US"]);
    expect(preloads()).toEqual(["/assets/ar-abc.js"]);
    expect(document.head.querySelector("link[rel=modulepreload]")).toHaveAttribute("crossorigin", "");
  });

  it("picks the language as the app does: the first of the browser's it speaks, English included", () => {
    open(["de-DE", "ja-JP", "ar"]);
    expect(preloads()).toEqual(["/assets/ja-def.js"]);
    document.head.innerHTML = "";
    open(["en-GB", "ar"]);
    expect(preloads()).toEqual([]);
  });

  it("follows the language the profile saved, over the browser's", () => {
    open(["ar"], { saved: JSON.stringify({ language: "pt" }) });
    expect(preloads()).toEqual(["/assets/pt-ghi.js"]);
    document.head.innerHTML = "";
    open(["ar"], { saved: JSON.stringify({ language: "en" }) });
    expect(preloads()).toEqual([]);
  });

  it("follows the profile the page will start as, and the space a handoff moved it to, not the default profile", () => {
    const registry = (active: string, space?: string) => JSON.stringify({ version: 1, active, profiles: [{ id: "", name: "Personal" }, { id: "abcdefghij", name: "Work", space }] });
    localStorage.setItem("ghostly_profiles", registry("abcdefghij"));
    localStorage.setItem("ghostly_abcdefghij_app_settings", JSON.stringify({ language: "pt" }));
    open(["en-US"], { saved: JSON.stringify({ language: "ja" }) });
    expect(preloads()).toEqual(["/assets/pt-ghi.js"]);
    document.head.innerHTML = "";
    localStorage.clear();
    localStorage.setItem("ghostly_profiles", registry("abcdefghij", "moved-1"));
    localStorage.setItem("ghostly_moved-1_app_settings", JSON.stringify({ language: "ar" }));
    open(["en-US"]);
    expect(preloads()).toEqual(["/assets/ar-abc.js"]);
  });

  it("asks for nothing where the page names no files (the dev server), or names them badly, and still guards", () => {
    open(["ar"], { files: null });
    expect(preloads()).toEqual([]);
    document.head.innerHTML = '<meta name="ghostly-locales" content="{not json">';
    open(["ar"], { files: null, saved: "{also not json" });
    expect(preloads()).toEqual([]);
    expect(guard().details()).toContain("Ghostly boot report");
  });
});
