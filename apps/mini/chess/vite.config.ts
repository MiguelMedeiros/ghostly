/**
 * Builds Chess to one self-contained file, dist/index.html: the script and styles inline, nothing loaded by URL
 * (the runner's sandbox allows no other way in). The script is classic, not a module, so it runs the same when the
 * runner writes the entry into its frame with document.write.
 *
 * Third-party notices: every npm package the script carries goes into a comment at its top with its license text,
 * read from the package (chess.js is BSD-2-Clause, @noble/hashes MIT; both ask for their notice in copies). A
 * package with no license file fails the build.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"];

/** The notice block for the npm packages among these module ids. */
export function thirdPartyNotices(moduleIds: string[]): string {
  const packages = new Map<string, string>();
  for (const id of moduleIds) {
    const match = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(id.replace(/\\/g, "/").replace(/^\0/, ""));
    if (match) packages.set(match[2], match[1]);
  }
  const blocks = [...packages].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, dir]) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license?: string };
    const file = LICENSE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
    if (!file) throw new Error(`${name} has no license file to carry in the bundle`);
    return `${name} ${pkg.version} (${pkg.license ?? "see below"})\n\n${readFileSync(file, "utf8").trim()}`;
  });
  const text = `Third-party software in this file:\n\n${blocks.join("\n\n----\n\n")}`;
  if (text.includes("*/")) throw new Error("a license text would end the notice comment early");
  return text;
}

function singleFile(): Plugin {
  return {
    name: "ghostly-mini-app-single-file",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.values(bundle);
      const html = files.find((f) => f.type === "asset" && f.fileName.endsWith(".html"));
      const chunks = files.filter((f) => f.type === "chunk");
      const styles = files.filter((f) => f.type === "asset" && f.fileName.endsWith(".css"));
      if (!html || html.type !== "asset" || chunks.length !== 1 || chunks[0].type !== "chunk") {
        return this.error("expected one HTML page and one script chunk");
      }
      const chunk = chunks[0];
      const others = files.filter((f) => f !== html && f !== chunk && !styles.includes(f));
      if (others.length) return this.error(`files that cannot be inlined: ${others.map((f) => f.fileName).join(", ")}`);
      const code = chunk.code;
      const css = styles.map((s) => (s.type === "asset" ? String(s.source).replace(/\/\*\$vite\$:\d+\*\/\s*/g, "") : "")).join("\n");
      for (const [what, text, bad] of [["script", code, /<\/script|<!--/i], ["styles", css, /<\/style/i]] as const) {
        if (bad.test(text)) return this.error(`the ${what} contains text that would end its tag early`);
      }
      const notice = thirdPartyNotices(Object.keys(chunk.modules));
      // The page is written here whole rather than edited from Vite's: index.html is only the dev server's entry.
      html.source = [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
        "    <title>Chess</title>",
        `    <style>\n${css}</style>`,
        "  </head>",
        "  <body>",
        '    <div id="app"></div>',
        `    <script>\n/*!\n${notice}\n*/\n(() => {\n${code}\n})();\n</script>`,
        "  </body>",
        "</html>",
        "",
      ].join("\n");
      delete bundle[chunk.fileName];
      for (const s of styles) delete bundle[s.fileName];
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [singleFile()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    modulePreload: false,
    reportCompressedSize: false,
  },
});
