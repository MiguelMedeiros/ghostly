import type { Plugin } from "vite";

/**
 * The built page's stylesheets ahead of its scripts. Vite writes the entry's `<link rel="stylesheet">`s after the entry
 * script and its seventy-odd `modulepreload`s; on a slow connection the browser then fetched the stylesheets behind
 * that JavaScript, and the page, whose first paint (index.html's #boot-shell) waits for every stylesheet in <head>,
 * drew nothing until they came. Moved ahead, they are among the first requests. Their own order is kept.
 */
export function stylesheetsFirst(html: string): string {
  const sheets = html.match(/[ \t]*<link rel="stylesheet"[^>]*>\n?/g);
  const script = /[ \t]*<script type="module"/.exec(html);
  if (!sheets || !script) return html;
  const firstSheet = html.indexOf(sheets[0]!);
  if (firstSheet < script.index) return html;
  let rest = html;
  for (const sheet of sheets) rest = rest.replace(sheet, "");
  const at = rest.indexOf(script[0]);
  return rest.slice(0, at) + sheets.map((sheet) => sheet.replace(/\n?$/, "\n")).join("") + rest.slice(at);
}

/** As a Vite plugin: on the built index.html, after Vite has written its tags. */
export function stylesheetsFirstPlugin(): Plugin {
  return {
    name: "ghostly-stylesheets-first",
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (!context.bundle || !context.path.endsWith("index.html")) return html;
        return stylesheetsFirst(html);
      },
    },
  };
}
