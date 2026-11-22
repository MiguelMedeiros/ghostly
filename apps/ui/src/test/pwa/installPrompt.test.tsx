import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor, within, act, renderHook } from "@testing-library/react";
import { InstallHint, InstallSteps } from "../../components/InstallApp";
import { resetInstallPrompt, watchInstallPrompt, closeInstallSteps, countInstallVisit, dismissInstallHint, installHintShown, installState, installVisits, isAppleMobile, isMacSafari, promptInstall, startInstall, installStepsOpen, useInstallHint } from "../../lib/installPrompt";
import { renderApp } from "../render";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHARE_TARGET_PATH } from "../../../../web/src/sw/policy";
import { inviteRouteCode, protocolLinkCode } from "../../lib/url";
import { Route, Routes, useLocation } from "react-router-dom";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { listSessions } from "../../lib/storage";
import { localeFiles, localePreload } from "../../../../web/localePreload";

// covers: app.pwa.install-entry
describe("the install hint by keyboard", () => {
  /**
   * Not now and Install put the hint away from under the focused button (apps/ui/src/components/InstallApp.tsx): the key
   * that pressed one lands on New chat above it, never on the page's body.
   */

  /** happy-dom has no <dialog> modal; the dialog only needs to open. */
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

  afterEach(() => {
    vi.restoreAllMocks();
    resetInstallPrompt();
    localStorage.clear();
  });

  const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

  /** The chat list's header (New chat) above the hint, and the steps sheet beside the app, as the sidebar has them. */
  function list() {
    return renderApp(<>
      <button type="button" data-testid="sidebar-new-chat">New chat</button>
      <InstallHint hasChats />
      <InstallSteps />
    </>);
  }

  function offer() {
    window.dispatchEvent(Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: vi.fn(() => Promise.resolve()),
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    }));
  }

  it("Not now gives the focus to New chat", async () => {
    watchInstallPrompt();
    offer();
    const { user } = list();
    screen.getByTestId("install-hint-later").focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("install-hint")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus());
  });

  it("Install, with the browser's prompt, gives the focus to New chat", async () => {
    watchInstallPrompt();
    offer();
    const { user } = list();
    screen.getByTestId("install-hint-install").focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("install-hint")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus());
  });

  it("Install in Safari focuses Got it, and Got it gives the focus to New chat", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(SAFARI_MAC);
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(0);
    watchInstallPrompt();
    const { user } = list();
    screen.getByTestId("install-hint-install").focus();
    await user.keyboard("{Enter}");
    const done = await screen.findByTestId("install-steps-done");
    await waitFor(() => expect(done).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("install-steps")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus());
  });
});

// covers: app.pwa.install, app.pwa.shortcuts, app.pwa.share-target, app.pwa.protocol
/**
 * The web app's manifest, checked the way a browser decides the app can be installed (Lighthouse no longer has a
 * PWA category, so this is the check CI runs), and against the code that answers what it declares.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const manifest = JSON.parse(read("apps/web/public/manifest.json"));
const html = read("apps/web/index.html");
const routes = read("apps/ui/src/Root.tsx");

describe("installable", () => {
  it("is linked from the page, with the Apple tags for Add to Home Screen", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.json" />');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
    expect(html).toContain('rel="apple-touch-icon"');
  });

  it("has what installing asks for: names, a start inside its scope, standalone, 192 and 512 icons, a maskable one", () => {
    expect(manifest.name).toBe("Ghostly");
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.id).toBe("/");
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(manifest.display).toBe("standalone");
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) expect(() => read(`apps/web/public${icon.src}`)).not.toThrow();
  });
});

describe("a link to the app, shared", () => {
  /** The `content` of the page's meta tag with this name or property, or undefined. */
  const meta = (key: string) => new RegExp(`<meta (?:name|property)="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" content="([^"]*)" />`).exec(html)?.[1];

  it("shows the app's description and the website's share card, not a bare \"Ghostly\"", () => {
    expect(meta("description")).toBe(manifest.description);
    expect(meta("og:description")).toBe(manifest.description);
    expect(meta("og:title")).toBe(manifest.name);
    expect(meta("og:site_name")).toBe(manifest.name);
    expect(meta("og:type")).toBe("website");
    expect(meta("twitter:card")).toBe("summary_large_image");
    // The website's image (apps/website/lib/pageMeta.ts), at its size: absolute, so it is the same from any host.
    const website = read("apps/website/lib/pageMeta.ts");
    expect(meta("og:image")).toBe("https://ghostly.tools/og-image.png");
    expect(website).toContain("url: `${SITE_URL}/og-image.png`");
    expect(website).toContain('export const SITE_URL = "https://ghostly.tools"');
    expect(() => read("apps/website/public/og-image.png")).not.toThrow();
    expect([meta("og:image:width"), meta("og:image:height")]).toEqual(["1200", "630"]);
    expect(meta("og:image:alt")).toBe(/alt: "([^"]+)"/.exec(website)?.[1]);
    // No og:url: a card links to the address that was shared (an invite in its fragment, another host's copy).
    expect(meta("og:url")).toBeUndefined();
  });
});

describe("what it declares, the app answers", () => {
  it("each shortcut opens a route the app has", () => {
    const urls = manifest.shortcuts.map((s: { url: string }) => s.url);
    expect(urls).toEqual(["/#/new", "/#/scan", "/#/wallet"]);
    for (const url of urls) expect(routes).toContain(`path="${url.slice(2)}"`);
    expect(manifest.shortcuts.map((s: { name: string }) => s.name)).toEqual(["New chat", "Scan invite", "Wallets"]);
  });

  it("the share target posts, as a form with files, where the worker takes it", () => {
    expect(manifest.share_target).toMatchObject({ action: SHARE_TARGET_PATH, method: "POST", enctype: "multipart/form-data" });
    expect(manifest.share_target.params).toMatchObject({ title: "title", text: "text", url: "url" });
    expect(manifest.share_target.params.files[0].name).toBe("files");
  });

  it("web+ghostly: links open the app with the link in the fragment", () => {
    expect(manifest.protocol_handlers).toEqual([{ protocol: "web+ghostly", url: "/#%s" }]);
  });

  it("a link to the app (the Add a device QR code, opened by a phone's camera) opens the installed app, in its open window", () => {
    expect(manifest.handle_links).toBe("preferred");
    expect(manifest.launch_handler).toEqual({ client_mode: ["navigate-existing", "auto"] });
    // A device code arriving in a window that is open already changes only the fragment: the router's intake takes it.
    expect(routes).toContain("isDeviceCode(rest)");
  });
});

// covers: app.pwa.protocol
describe("a web+ghostly: link in the address", () => {
  const CODE = "ghostly1pqqqqqqqqq";

  it("as the browser hands it over (escaped) or as written", () => {
    expect(protocolLinkCode(`/web%2Bghostly%3A${CODE}`)).toBe(CODE);
    expect(protocolLinkCode(`web%2Bghostly%3A${CODE}`)).toBe(CODE);
    expect(protocolLinkCode(`/web+ghostly:${CODE}`)).toBe(CODE);
    expect(protocolLinkCode(`/WEB+GHOSTLY:${CODE}`)).toBe(CODE);
    expect(protocolLinkCode(`/web%2Bghostly%3A%2F%2F${CODE}`)).toBe(CODE);
    expect(protocolLinkCode(`/web+ghostly://${CODE}`)).toBe(CODE);
  });

  it("is read as the invite it holds, like #ghostly1…", () => {
    expect(inviteRouteCode(`/web%2Bghostly%3A${CODE}`)).toBe(CODE);
    expect(inviteRouteCode(`/${CODE}`)).toBe(CODE);
  });

  it("holding something else, or nothing, is still taken (and refused) rather than left in the address", () => {
    expect(inviteRouteCode("/web%2Bghostly%3Anonsense")).toBe("nonsense");
    expect(inviteRouteCode("/web%2Bghostly%3A")).toBe("web+ghostly:");
    expect(protocolLinkCode("/web%2Bghostly%3A%E0%A4%A")).toBe("%E0%A4%A");
  });

  it("other addresses are not links", () => {
    expect(protocolLinkCode("/")).toBeNull();
    expect(protocolLinkCode("/settings")).toBeNull();
    expect(protocolLinkCode("/chat/web+ghostly:x")).toBeNull();
    expect(protocolLinkCode("/web+nostr:npub1")).toBeNull();
  });
});

// covers: app.pwa.shortcuts
describe("the New shortcut (#/new)", () => {
  function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
  const openAt = (route: string) => renderApp(<UpdateProvider><Sidebar /><Routes><Route path="*" element={<Where />} /></Routes></UpdateProvider>, { route });

  /** Any site can send the browser to `#/new`: the installed app's New chat shortcut opens New, and a press makes the chat. */
  it("`#/new` opens New with Chat focused and makes no chat until it is pressed", async () => {
    const { user } = openAt("/new");
    const chat = within(await screen.findByTestId("sidebar-new-menu")).getAllByRole("button")[0];
    expect(chat).toHaveTextContent(/^Chat/);
    await waitFor(() => expect(chat).toHaveFocus());
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
    expect(listSessions()).toEqual([]);

    await user.keyboard("{Enter}");
    await waitFor(() => expect(listSessions()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/chat/${listSessions()[0].id}`));
  });

  it("on the rail too, `#/new` opens New from the rail's New and makes no chat by itself", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    const { user } = openAt("/new");
    expect(screen.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
    const chat = within(await screen.findByTestId("sidebar-new-menu")).getAllByRole("button")[0];
    await waitFor(() => expect(chat).toHaveFocus());
    expect(listSessions()).toEqual([]);

    await user.click(chat);
    await waitFor(() => expect(listSessions()).toHaveLength(1));
  });
});

// covers: app.pwa.shortcuts
describe("the Scan shortcut (#/scan)", () => {
  /** happy-dom has no <dialog> modal; the dialog only needs to open. */
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

  function Where() { return <p data-testid="where">{useLocation().pathname}</p>; }
  const openAt = (route: string) => renderApp(<UpdateProvider><Sidebar /><Routes><Route path="*" element={<Where />} /></Routes></UpdateProvider>, { route });

  // A camera that would start: a press is what turns it on.
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop() {} }] }));
  beforeEach(() => { getUserMedia.mockClear(); vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia } }); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Any site can send the browser to `#/scan`: the installed app's Scan invite shortcut opens Join, and a press starts the camera. */
  it("`#/scan` opens Join with Scan focused and starts no camera until it is pressed", async () => {
    const { user } = openAt("/scan");
    expect(await screen.findByRole("heading", { name: "Join a chat or group", hidden: true })).toBeInTheDocument();
    // Long enough for a camera started on opening to have been asked for.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getUserMedia).not.toHaveBeenCalled();
    const scan = screen.getByRole("button", { name: "Scan QR", hidden: true });
    await waitFor(() => expect(scan).toHaveFocus());
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
    expect(listSessions()).toEqual([]);

    await user.keyboard("{Enter}");
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
  });
});

// covers: app.i18n
describe("the build's language files", () => {
  /**
   * The language files the web build names in its page, for the boot guard to ask for before the bundle has run
   * (apps/web/public/boot-guard.js; apps/ui/src/test/app/bootGuard.test.ts runs that half).
   */
  const BUNDLE = [
    { type: "chunk", fileName: "assets/main-abc.js", facadeModuleId: "/repo/apps/web/index.html" },
    { type: "chunk", fileName: "assets/layout-def.js", facadeModuleId: null },
    { type: "chunk", fileName: "assets/ar-111.js", facadeModuleId: "/repo/apps/ui/src/locales/ar/index.ts" },
    { type: "chunk", fileName: "assets/ja-222.js", facadeModuleId: "C:\\repo\\apps\\ui\\src\\locales\\ja\\index.ts" },
    { type: "chunk", fileName: "assets/chat-333.js", facadeModuleId: "/repo/apps/ui/src/locales/ar/chat.json" },
    { type: "asset", fileName: "assets/pt-444.js", facadeModuleId: "/repo/apps/ui/src/locales/pt/index.ts" },
  ];

  it("are the chunks each language's folder is built from, under the build's base", () => {
    expect(localeFiles(BUNDLE)).toEqual({ ar: "/assets/ar-111.js", ja: "/assets/ja-222.js" });
    expect(localeFiles(BUNDLE, "/app/")).toEqual({ ar: "/app/assets/ar-111.js", ja: "/app/assets/ja-222.js" });
  });

  it("go into the app's page, before the boot guard runs, and not into the sign-in callback's", () => {
    const plugin = localePreload();
    const hook = plugin.transformIndexHtml as { handler: (html: string, context: object) => unknown };
    const bundle = Object.fromEntries(BUNDLE.map((file) => [file.fileName, file]));
    expect(hook.handler("<html></html>", { path: "/index.html", bundle })).toEqual({
      html: "<html></html>",
      tags: [{ tag: "meta", attrs: { name: "ghostly-locales", content: '{"ar":"/assets/ar-111.js","ja":"/assets/ja-222.js"}' }, injectTo: "head-prepend" }],
    });
    expect(hook.handler("<html></html>", { path: "/oidc-callback.html", bundle })).toBe("<html></html>");
    // The dev server: no bundle, nothing named.
    expect(hook.handler("<html></html>", { path: "/index.html" })).toBe("<html></html>");
  });
});

// covers: app.pwa.install, app.pwa.install-entry
describe("the install prompt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetInstallPrompt();
    localStorage.clear();
  });

  const SAFARI_MAC = (version: number) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version}.0 Safari/605.1.15`;
  const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const EDGE_MAC = `${CHROME_MAC} Edg/131.0.0.0`;
  const FIREFOX_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0";

  /** The page as this browser, for `installState()` (which reads navigator itself). */
  function asBrowser(userAgent: string, touchPoints = 0) {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(touchPoints);
  }

  function offer(outcome: "accepted" | "dismissed") {
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: vi.fn(() => Promise.resolve()),
      userChoice: Promise.resolve({ outcome }),
    });
    window.dispatchEvent(event);
    return event;
  }

  describe("installing the web app", () => {
    it("offers nothing where the page does not watch (the extension, Desktop)", () => {
      offer("accepted");
      expect(installState()).toBe("none");
    });

    it("takes the browser's offer (no banner of its own) and installs on request", async () => {
      watchInstallPrompt();
      const event = offer("accepted");
      expect(event.defaultPrevented).toBe(true);
      expect(installState()).toBe("prompt");
      await expect(promptInstall()).resolves.toBe(true);
      expect(event.prompt).toHaveBeenCalledTimes(1);
      // An offer is used once.
      expect(installState()).not.toBe("prompt");
      await expect(promptInstall()).resolves.toBe(false);
      window.dispatchEvent(new Event("appinstalled"));
      expect(installState()).toBe("installed");
    });

    it("a person who says no gets no second prompt from the same offer", async () => {
      watchInstallPrompt();
      offer("dismissed");
      await expect(promptInstall()).resolves.toBe(false);
    });

    it("recognises iPhones and iPads, which install from Safari's Share menu", () => {
      expect(isAppleMobile("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", 5)).toBe(true);
      expect(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
      expect(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
      expect(isAppleMobile("Mozilla/5.0 (Linux; Android 15)", 5)).toBe(false);
    });

    it("recognises Safari on a Mac from 17, which adds the app to the Dock from its File menu", () => {
      expect(isMacSafari(SAFARI_MAC(17), 0)).toBe(true);
      expect(isMacSafari(SAFARI_MAC(18), 0)).toBe(true);
      expect(isMacSafari(SAFARI_MAC(16), 0)).toBe(false);
      // Chromium browsers on a Mac say Safari too; they have the prompt instead. Firefox has no install at all.
      expect(isMacSafari(CHROME_MAC, 0)).toBe(false);
      expect(isMacSafari(EDGE_MAC, 0)).toBe(false);
      expect(isMacSafari(FIREFOX_MAC, 0)).toBe(false);
      // An iPad asking for desktop sites says Macintosh, with a touch screen: Share menu, not File menu.
      expect(isMacSafari(SAFARI_MAC(18), 5)).toBe(false);
      expect(isMacSafari("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", 5)).toBe(false);
    });

    it("offers the Dock on Safari for Mac, the Share menu on an iPad in desktop mode, and nothing on Firefox", () => {
      watchInstallPrompt();
      asBrowser(SAFARI_MAC(17));
      expect(installState()).toBe("dock");
      asBrowser(SAFARI_MAC(17), 5);
      expect(installState()).toBe("ios");
      asBrowser(FIREFOX_MAC);
      expect(installState()).toBe("none");
    });

    it("the browser's offer comes before any steps: Chromium on a Mac gets its prompt", () => {
      watchInstallPrompt();
      asBrowser(CHROME_MAC);
      expect(installState()).toBe("none");
      offer("accepted");
      expect(installState()).toBe("prompt");
    });

    it("Install on Safari opens the steps, which close again", () => {
      watchInstallPrompt();
      asBrowser(SAFARI_MAC(18));
      expect(installStepsOpen()).toBe(false);
      startInstall();
      expect(installStepsOpen()).toBe(true);
      closeInstallSteps();
      expect(installStepsOpen()).toBe(false);
    });

    it("Install where the browser offers it asks the browser, and opens no steps", async () => {
      watchInstallPrompt();
      const event = offer("accepted");
      startInstall();
      await vi.waitFor(() => expect(event.prompt).toHaveBeenCalledTimes(1));
      expect(installStepsOpen()).toBe(false);
    });
  });

  /**
   * A page of the web app as apps/web/src/main.tsx starts it: the watch at once, the visit once the tab is the app
   * (`peer`); a tab that shows "already open in another tab" never is. `reload` keeps the tab's sessionStorage.
   */
  function openPage({ peer = true, reload = false } = {}) {
    resetInstallPrompt();
    if (!reload) sessionStorage.clear();
    watchInstallPrompt();
    if (peer) countInstallVisit();
    offer("accepted");
  }

  describe("the hint above the chat list", () => {
    afterEach(() => sessionStorage.clear());

    it("waits until the app has been used a little: a chat of its own, or a second visit", () => {
      openPage();
      expect(installVisits()).toBe(1);
      expect(installHintShown(installState(), false)).toBe(false);
      expect(installHintShown(installState(), true)).toBe(true);

      // The next time the web app opens (a new tab: the watch starts over).
      openPage();
      expect(installVisits()).toBe(2);
      expect(installHintShown(installState(), false)).toBe(true);
    });

    it("a reload is the same visit: no hint on a newcomer's empty first screen", () => {
      openPage();
      openPage({ reload: true });
      expect(installVisits()).toBe(1);
      expect(installHintShown(installState(), false)).toBe(false);
      // Nor the app's own reloads after it (a new version, Back): still the first visit.
      openPage({ reload: true });
      expect(installHintShown(installState(), false)).toBe(false);
    });

    it("a tab that only waits for the open one is no visit, and other tabs never move this page's", () => {
      openPage({ peer: false });
      expect(installVisits()).toBe(0);

      openPage();
      expect(installVisits()).toBe(1);
      // Another tab counts its own visit while this one stays open on its first.
      localStorage.setItem("ghostly-install-visits", "2");
      expect(installHintShown(installState(), false)).toBe(false);
    });

    it("Not now puts it away for good, and Install stays where it was", () => {
      watchInstallPrompt();
      offer("accepted");
      dismissInstallHint();
      expect(installHintShown(installState(), true)).toBe(false);
      resetInstallPrompt();
      watchInstallPrompt();
      offer("accepted");
      expect(installHintShown(installState(), true)).toBe(false);
      expect(installState()).toBe("prompt");
    });

    it("once Install was used it has done its job (Safari never says the app was added)", () => {
      watchInstallPrompt();
      asBrowser(SAFARI_MAC(18));
      expect(installHintShown(installState(), true)).toBe(true);
      startInstall();
      expect(installHintShown(installState(), true)).toBe(false);
    });

    it("goes once the app is installed, and never shows in the installed app", () => {
      watchInstallPrompt();
      offer("accepted");
      expect(installHintShown(installState(), true)).toBe(true);
      window.dispatchEvent(new Event("appinstalled"));
      expect(installHintShown(installState(), true)).toBe(false);

      resetInstallPrompt();
      vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
      watchInstallPrompt();
      expect(installState()).toBe("installed");
      expect(installHintShown(installState(), true)).toBe(false);
    });

    it("never shows in the extension or Desktop, which do not watch", () => {
      asBrowser(SAFARI_MAC(18));
      offer("accepted");
      expect(installState()).toBe("none");
      expect(installHintShown(installState(), true)).toBe(false);
    });

    it("Not now in another tab of the app puts it away in this one, with nothing else drawing the list", () => {
      watchInstallPrompt();
      offer("accepted");
      const { result } = renderHook(() => useInstallHint(true));
      expect(result.current).toBe(true);
      // What the other tab's dismissInstallHint() does here: its write, and the storage event this tab gets for it.
      localStorage.setItem("ghostly-install-hint", "dismissed");
      act(() => { window.dispatchEvent(new StorageEvent("storage", { key: "ghostly-install-hint", newValue: "dismissed" })); });
      expect(result.current).toBe(false);
    });

    it("works where storage refuses (a private window): shown once there are chats, Not now still puts it away", () => {
      vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
      vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
      expect(() => watchInstallPrompt()).not.toThrow();
      offer("accepted");
      expect(installVisits()).toBe(0);
      expect(installHintShown(installState(), true)).toBe(true);
      expect(() => dismissInstallHint()).not.toThrow();
      expect(installHintShown(installState(), true)).toBe(false);
    });
  });
});
