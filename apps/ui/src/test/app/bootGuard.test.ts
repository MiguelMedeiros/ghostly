import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// covers: app.boot

/*
 * The boot guard (apps/web/public/boot-guard.js): the plain script that speaks when the app never draws. Run here
 * as the page runs it, a classic script before the bundle, against a document with an empty #root.
 */

const SOURCE = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "apps/web/public/boot-guard.js"), "utf8");
const OLD_WEBVIEW = "Mozilla/5.0 (Linux; Android 9; SM-G960F; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/92.0.4515.159 Mobile Safari/537.36";
const NEW_ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const OLD_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 15_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.3 Mobile/15E148 Safari/604.1";

interface Guard { details(): string; clean(text: string): string }
const guard = () => (window as unknown as { __ghostlyBoot: Guard }).__ghostlyBoot;
const panel = () => document.getElementById("boot-fallback");

function start({ agent = NEW_ANDROID, language = "en-US", loaded = true } = {}) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
  vi.spyOn(navigator, "language", "get").mockReturnValue(language);
  vi.spyOn(document, "readyState", "get").mockReturnValue(loaded ? "complete" : "loading");
  document.body.innerHTML = '<div id="root"></div>';
  new Function(SOURCE)();
}

function fail(message: string, name = "TypeError") {
  const error = new Error(message);
  error.name = name;
  window.dispatchEvent(new ErrorEvent("error", { error, message, filename: "https://app.example/assets/main-abc.js?v=1", lineno: 3, colno: 9 }));
}

const draw = () => { document.getElementById("root")!.appendChild(document.createElement("div")); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  // What the guard set up goes with it: a drawn root ends it (listeners and timers), then the page is emptied.
  if (document.getElementById("root")) { draw(); vi.advanceTimersByTime(1000); }
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
    // Over for good: a later error is the app's own error screen's business.
    fail("later");
    vi.advanceTimersByTime(5000);
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
