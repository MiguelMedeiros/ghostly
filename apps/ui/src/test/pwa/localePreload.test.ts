import { describe, expect, it } from "vitest";
import { localeFiles, localePreload } from "../../../../web/localePreload";

// covers: app.i18n

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

describe("the build's language files", () => {
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
