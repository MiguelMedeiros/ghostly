// The store pages (/apps) check the official store with the app's own readers, not a look-alike: this copies the
// store index and bundle readers from packages/core/src into lib/store-core, unchanged, so the site refuses exactly
// what the app refuses (WISP 1200 · Stores, The package).
// Core is the source of truth: edit core's file, then run `npm run sync:store-core`. CI runs it with --check and fails
// when a copy differs from core's file.
//
// Copies rather than imports: the site builds with only apps/website/ in its Turbopack root (lib/invite.ts says why).
// `signer.ts` is the one file not copied: core's pulls in the identity module, and the readers use only its type.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = resolve(root, "packages", "core", "src");
const destination = resolve(root, "apps", "website", "lib", "store-core");

/** The readers' closure in packages/core/src: the index, the bundle, their signatures, canonical JSON, bytes, the icon's size. */
export const FILES = ["appStore.ts", "appBundle.ts", "appStatements.ts", "canonicalJson.ts", "bytes.ts", "image.ts"];

const note = (file) => `// Copied from packages/core/src/${file} by apps/website/scripts/sync-store-core.mjs. Edit core's file, then run npm run sync:store-core.\n`;
const copyOf = (file) => note(file) + readFileSync(resolve(source, file), "utf8");

/** The `Signer` type alone: the readers import it for their signing halves, which the site never calls. */
const SIGNER = `// Written by apps/website/scripts/sync-store-core.mjs: the type of packages/core/src/signer.ts, which the copied readers
// name for signing. The site only reads, so it needs no signer.
export interface Signer {
  readonly publicKey: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}
`;

const wanted = new Map([...FILES.map((file) => [file, () => copyOf(file)]), ["signer.ts", () => SIGNER]]);

// Imported for FILES alone by tools/scripts/test/ci-changes.test.ts (which core files the site's CI job reads): run
// only when invoked.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [file, make] of wanted) {
    const target = resolve(destination, file);
    const want = make();
    const have = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (have === want) continue;
    if (check) stale.push(have === null ? `${file} (missing)` : file);
    else {
      mkdirSync(destination, { recursive: true });
      writeFileSync(target, want);
    }
  }
  for (const extra of existsSync(destination) ? readdirSync(destination) : []) {
    if (wanted.has(extra)) continue;
    if (check) stale.push(`${extra} (not core's)`);
    else rmSync(resolve(destination, extra), { recursive: true });
  }
  if (check && stale.length) {
    console.error(`apps/website/lib/store-core is out of step with core's readers:\n  ${stale.join("\n  ")}\nRun: cd apps/website && npm run sync:store-core`);
    process.exit(1);
  }
  console.log(check ? `The store readers: ${wanted.size} files match.` : `The store readers: ${wanted.size} files copied.`);
}
