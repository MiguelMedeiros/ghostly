import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

/**
 * Every package a workspace's `src/` imports is in that workspace's package.json. npm hoists `@ghostly/core`'s
 * dependencies to the root, so packages/browser imported @noble/*, @scure/base and keet-identity-key with nothing in
 * its own manifest: they resolved to whatever copy core's pins hoisted, and the lock also holds older copies of the
 * same packages under nostr-tools, ethers and bip39. A change in core's pins, or in which copy npm hoists, changed what
 * browser's code got, and nothing recorded it. The website's deps-used test checks the other way round.
 *
 * The shared UI in apps/ui is no workspace: every app builds its `src/` from the root, so the root's package.json is
 * its manifest. It imported highlight.js and hast through lowlight, the one the root declared.
 *
 * A workspace's tests and build config may also use what the root declares (vitest, vite, the testing libraries), but
 * not what only another package depends on: packages/cli's vite config resolved openpgp, which only packages/browser
 * declares. The website and the native runtimes install from locks of their own, so they answer to their own manifest
 * alone: the website's app-icon route imported sharp, there only as Next's optional dependency, and the translation
 * runtime bare-fs and bare-path, there only as its addon's.
 */
const root = resolve(import.meta.dirname, "../../..");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
const tracked = (...paths: string[]) =>
  execFileSync("git", ["ls-files", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

/**
 * The bare specifiers a file imports, read from TypeScript's syntax tree (not words in comments, strings or regexes):
 * static and dynamic imports, re-exports, `import("x")` types, `require("x")` and `require.resolve`/`import.meta.resolve`.
 */
const imports = (file: string, text: string) => {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node)) {
      const { argument } = node;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) found.push(argument.literal.text);
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      const resolves =
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "resolve" &&
        ((ts.isIdentifier(callee.expression) && callee.expression.text === "require") ||
          ts.isMetaProperty(callee.expression));
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require") ||
        resolves
      )
        found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest));
  // `@/` is the website's path alias for its own folders (tsconfig `paths`), not a package.
  return found.filter((name) => !name.startsWith(".") && !name.startsWith("/") && !name.startsWith("@/"));
};

/** The package an import names: `@scope/name` or `name`, without a subpath. */
const packageOf = (specifier: string) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

const isTest = (file: string) => /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);

const folderOf = (manifest: string) => manifest.replace(/\/package\.json$/, "");

const workspaces = (): string[] =>
  tracked(...json("package.json").workspaces.map((p: string) => `${p}/package.json`)).map(folderOf);

/** Folders that install from a lock of their own, outside the root's workspaces. */
const standalone = (): string[] => tracked("apps/website/package.json", ":(glob)native/**/package.json").map(folderOf);

/** Folders whose `src/` the root's package.json answers for: the shared UI every app builds. */
const rootOwned = ["apps/ui"];

const declaredIn = (path: string) => {
  const manifest = json(path);
  return [
    manifest.name,
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
};

/** The code files under a folder, less any folder below it with a package.json of its own (packages/sdk/examples). */
const codeFiles = (folder: string) => {
  const nested = tracked(`${folder}/**/package.json`)
    .map(folderOf)
    .filter((inner) => inner !== folder);
  return tracked(folder).filter(
    (file) =>
      /\.[cm]?[jt]sx?$/.test(file) &&
      !/\.d\.[cm]?ts$/.test(file) &&
      !nested.some((inner) => file.startsWith(`${inner}/`)),
  );
};

const undeclared = (folder: string, files: string[], declared: Set<string>): string[] => {
  const missing = new Map<string, string>();
  for (const file of files) {
    for (const specifier of imports(file, readFileSync(join(root, file), "utf8"))) {
      const name = packageOf(specifier);
      if (specifier.startsWith("node:") || builtinModules.includes(name) || declared.has(name)) continue;
      // A package imported only for its types (hast) has them in DefinitelyTyped's @types/<name>.
      if (declared.has(`@types/${name}`)) continue;
      if (!missing.has(name)) missing.set(name, file);
    }
  }
  return [...missing].map(([name, file]) => `${folder}: ${name} (e.g. ${file})`).sort();
};

const isShipped = (folder: string) => (file: string) => file.startsWith(`${folder}/src/`) && !isTest(file);

it("every package a workspace's src imports is declared in its own package.json", () => {
  const list = workspaces();
  expect(list).toContain("packages/browser");
  expect(
    list.flatMap((folder) =>
      undeclared(folder, codeFiles(folder).filter(isShipped(folder)), new Set(declaredIn(`${folder}/package.json`))),
    ),
  ).toEqual([]);
}, 30_000);

it("every package a workspace's tests and config import is declared in its own package.json or the root's", () => {
  const rootDeclared = declaredIn("package.json");
  expect(
    workspaces().flatMap((folder) =>
      undeclared(
        folder,
        codeFiles(folder).filter((file) => !isShipped(folder)(file)),
        new Set([...declaredIn(`${folder}/package.json`), ...rootDeclared]),
      ),
    ),
  ).toEqual([]);
}, 30_000);

it("every package the website and the native runtimes import is declared in their own package.json", () => {
  const list = standalone();
  expect(list).toEqual(expect.arrayContaining(["apps/website", "native/translation"]));
  expect(
    list.flatMap((folder) => undeclared(folder, codeFiles(folder), new Set(declaredIn(`${folder}/package.json`)))),
  ).toEqual([]);
}, 30_000);

it("every package the shared UI's src imports is declared in the root's package.json", () => {
  expect(
    rootOwned.flatMap((folder) =>
      undeclared(folder, codeFiles(folder).filter(isShipped(folder)), new Set(declaredIn("package.json"))),
    ),
  ).toEqual([]);
}, 30_000);
