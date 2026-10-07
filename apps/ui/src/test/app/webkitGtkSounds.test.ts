import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// covers: app.attention.sounds

vi.mock("../../lib/sounds", () => ({ setSoundsRelease: vi.fn() }));

import { setSoundsRelease } from "../../lib/sounds";
import { browserSoundsRelease, isWebKitGtk, webkitGtkFloor, webkitGtkSoundsRelease, type WebFeatures } from "../../lib/webkitGtk";
import { gateSounds } from "../../../../web/src/sounds";

/*
 * The web app in a WebKitGTK browser (GNOME Web and the like) has the Linux Desktop's freeze (#1419): before 2.52 an
 * AudioContext.resume() after a suspend() holds the page for 5 to 16 s. Its user agent is the same on 2.50 and 2.52
 * (WebKit's UserAgentGLib.cpp sends "Version/60.5" on both branches), so what 2.52 enables tells them apart.
 */

// User agents as WebKitGTK builds them (Epiphany sends WebKit's own).
const UBUNTU_2204 = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
const DEBIAN_12 = "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const FEDORA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
const TECH_PREVIEW = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15";
const LINUX_PHONE = "Mozilla/5.0 (Linux; like Android 4.4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Mobile Safari/605.1.15";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const SAFARI_IPAD = "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/605.1.15";
const CHROME_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";
const FIREFOX_UBUNTU = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36";
const CHROME_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1";

/** What a page sees of 2.52's features: WebKitGTK 2.52 and later enable the Navigation API and CSS field-sizing. */
const WEBKITGTK_252: WebFeatures = { navigation: {}, CSS: { supports: (property, value) => property === "field-sizing" && value === "content" } };
const WEBKITGTK_250: WebFeatures = { CSS: { supports: () => false } };

afterEach(() => vi.mocked(setSoundsRelease).mockClear());

describe("a WebKitGTK browser, told from its user agent", () => {
  it("is GNOME Web and the like, on any distribution, a Linux phone included", () => {
    for (const agent of [UBUNTU_2204, DEBIAN_12, FEDORA, TECH_PREVIEW, LINUX_PHONE]) expect(isWebKitGtk(agent)).toBe(true);
    expect(isWebKitGtk("Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15")).toBe(true);
    expect(isWebKitGtk("Mozilla/5.0 (X11; FreeBSD amd64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15")).toBe(true);
  });

  it("is not Safari on a Mac, an iPhone or an iPad, nor Chrome, Firefox or Android's browsers", () => {
    for (const agent of [SAFARI_MAC, SAFARI_IPHONE, SAFARI_IPAD, CHROME_LINUX, FIREFOX_LINUX, FIREFOX_UBUNTU, ANDROID_CHROME, ANDROID_WEBVIEW, CHROME_IOS, ""]) {
      expect(isWebKitGtk(agent)).toBe(false);
    }
  });
});

describe("the oldest WebKitGTK a page can be on", () => {
  it("is 2.52 with the Navigation API and CSS field-sizing, not known without both", () => {
    expect(webkitGtkFloor(WEBKITGTK_252)).toEqual([2, 52]);
    expect(webkitGtkFloor(WEBKITGTK_250)).toBeNull();
    expect(webkitGtkFloor({ navigation: {}, CSS: { supports: () => false } })).toBeNull();
    expect(webkitGtkFloor({ CSS: WEBKITGTK_252.CSS })).toBeNull();
    expect(webkitGtkFloor({})).toBeNull();
    expect(webkitGtkFloor({ navigation: {}, CSS: { supports: () => { throw new Error("no"); } } })).toBeNull();
  });
});

describe("whether the web app suspends the sounds' output between sounds", () => {
  it("keeps it running in GNOME Web on Ubuntu 22.04 and Debian 12 (WebKitGTK before 2.52)", () => {
    expect(browserSoundsRelease(UBUNTU_2204, WEBKITGTK_250, false)).toBe("keep");
    expect(browserSoundsRelease(DEBIAN_12, WEBKITGTK_250, false)).toBe("keep");
    expect(browserSoundsRelease(LINUX_PHONE, WEBKITGTK_250, false)).toBe("keep");
  });

  it("suspends it in GNOME Web on Fedora and in Epiphany Technology Preview (WebKitGTK 2.52 and later)", () => {
    expect(browserSoundsRelease(FEDORA, WEBKITGTK_252, false)).toBe("suspend");
    expect(browserSoundsRelease(TECH_PREVIEW, WEBKITGTK_252, false)).toBe("suspend");
  });

  it("leaves it alone in Safari, Chrome, Firefox and on Android, which resume at once", () => {
    for (const agent of [SAFARI_MAC, SAFARI_IPHONE, CHROME_LINUX, FIREFOX_LINUX, ANDROID_CHROME, ANDROID_WEBVIEW]) {
      expect(browserSoundsRelease(agent, WEBKITGTK_250, false)).toBeNull();
      expect(browserSoundsRelease(agent, WEBKITGTK_252, false)).toBeNull();
    }
  });

  it("leaves it to the Desktop app, which asks Rust for its WebKitGTK", () => {
    expect(browserSoundsRelease(UBUNTU_2204, WEBKITGTK_250, true)).toBeNull();
  });

  it("decides as the Desktop does for a WebKitGTK version", () => {
    expect(webkitGtkSoundsRelease(null)).toBe("keep");
    expect(webkitGtkSoundsRelease([2, 50, 4])).toBe("keep");
    expect(webkitGtkSoundsRelease([2, 52])).toBe("suspend");
    expect(webkitGtkSoundsRelease([3, 0, 0])).toBe("suspend");
  });
});

describe("the web host at start", () => {
  it("keeps the output running in GNOME Web before 2.52", () => {
    gateSounds(UBUNTU_2204, WEBKITGTK_250, false);
    expect(setSoundsRelease).toHaveBeenCalledWith("keep");
  });

  it("lets it be suspended in GNOME Web 2.52", () => {
    gateSounds(FEDORA, WEBKITGTK_252, false);
    expect(setSoundsRelease).toHaveBeenCalledWith("suspend");
  });

  it("is gated as the web app starts, before the first sound", () => {
    const main = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "web", "src", "main.tsx"), "utf8");
    expect(main).toMatch(/^import \{ gateSounds \} from "\.\/sounds";$/m);
    expect(main).toMatch(/^gateSounds\(\);$/m);
    expect(main.indexOf("gateSounds();")).toBeLessThan(main.indexOf("root.render(\n  <StrictMode>"));
  });

  it("changes nothing in other browsers", () => {
    gateSounds(CHROME_LINUX, WEBKITGTK_252, false);
    gateSounds(SAFARI_MAC, WEBKITGTK_250, false);
    expect(setSoundsRelease).not.toHaveBeenCalled();
  });
});
