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

/** Names that take a `#` and a number and are no repository: standards (PKCS#8). */
const NOT_A_REPOSITORY = new Set(["pkcs"]);

/**
 * The references in `body` to an issue of another repository written `<repo>#N` (no owner) or
 * `MiguelMedeiros/<repo>#N`, other than this repository's `ghostly#N`: a reader of the site may not be able to open it.
 * One written `owner/repo#N` (an upstream project's) is left alone. Code too: a span or a block is published as well.
 */
export function privateRefs(body) {
  return [...body.matchAll(/(?<![\w./-])(?:MiguelMedeiros\/)?([a-z][\w.-]*)#\d+/gi)]
    .filter((m) => m[1].toLowerCase() !== "ghostly" && !NOT_A_REPOSITORY.has(m[1].toLowerCase()))
    .map((m) => m[0]);
}
