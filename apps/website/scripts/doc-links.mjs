// A published document's relative links to Markdown files. The reader (lib/references.ts) turns one into a page of
// the site or a file on GitHub, so one that names no file of the repository opens a GitHub page that does not exist.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** The relative .md links of `body` (the document at `sourcePath`, from the repository's `root`) that name no file. */
export function missingDocLinks(body, sourcePath, root) {
  // Code is not read as links: a fenced block or a `span` may show how one is written.
  const prose = body.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
  const from = dirname(resolve(root, sourcePath));
  return [...prose.matchAll(/\]\(([^)\s]+)/g)]
    .map((m) => m[1])
    .filter((url) => !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(url))
    .filter((url) => /\.md$/i.test(url.split("#")[0]) && !existsSync(resolve(from, url.split("#")[0])));
}
