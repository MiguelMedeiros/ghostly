import type { Plugin } from "vite";

/** A language's own folder, apps/ui/src/locales/<language>/index.ts: the module each of its chunks is built from. */
const LOCALE_ENTRY = /\/apps\/ui\/src\/locales\/([a-z]{2})\/index\.ts$/;

/**
 * Each language's file in the build, `{ ar: "/assets/ar-abc.js" }`, from the chunks made of its folder
 * (apps/ui/src/locales/index.ts loads them with `import.meta.glob`). English is in the entry and has none.
 */
export function localeFiles(bundle: Iterable<{ type: string; fileName: string; facadeModuleId?: string | null }>, base = "/"): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of bundle) {
    const language = file.type === "chunk" ? LOCALE_ENTRY.exec((file.facadeModuleId ?? "").replace(/\\/g, "/"))?.[1] : undefined;
    if (language) files[language] = base + file.fileName;
  }
  return files;
}

/**
 * The language files' names in the page, `<meta name="ghostly-locales">`, for the boot guard (public/boot-guard.js):
 * it runs before the bundle and asks for the profile's language file at once (a modulepreload), beside the entry's
 * files. Left to `loadLocale` in main.tsx, that file is asked for only once the whole entry has downloaded and run, a
 * round trip later on a slow network. Before the boot guard in the page: it reads the meta as it runs. The dev server
 * has no bundle and no meta; there the app loads the language as before.
 */
export function localePreload(): Plugin {
  let base = "/";
  return {
    name: "ghostly-locale-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (!context.bundle || !context.path.endsWith("/index.html")) return html;
        const files = localeFiles(Object.values(context.bundle), base);
        if (!Object.keys(files).length) return html;
        return { html, tags: [{ tag: "meta", attrs: { name: "ghostly-locales", content: JSON.stringify(files) }, injectTo: "head-prepend" }] };
      },
    },
  };
}
