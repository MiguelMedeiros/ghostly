// The home's wallet deck is the app's own deck, not a look-alike: this copies the app's deck, the wallet card's
// face and its marks from src/components into components/app, keeping their paths, so their relative imports hold.
// The app is the source of truth: edit the app's file, then run `npm run sync:app-deck`. CI runs it with --check
// and fails when a copy differs from the app's file.
//
// Copies rather than imports: the site builds with only website/ (plus docs) in its Docker context, and a file
// outside it would resolve `react` from the repository's node_modules, a second React.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = resolve(root, "src/components");
const destination = resolve(root, "website/components/app");

/** Everything the deck needs, and nothing that reaches the engine (walletCardData.ts does). */
export const FILES = [
  "deck/Deck.tsx",
  "deck/stack.ts",
  "deck/motion.ts",
  "deck/deck.css",
  "WalletCardDeck.tsx",
  "WalletCards.tsx",
  "walletCardTypes.ts",
  "wallet-deck.css",
  "wallet-cards.css",
];

const note = (file) => `Copied from src/components/${file} by website/scripts/sync-app-deck.mjs. Edit the app's file, then run npm run sync:app-deck.`;
const copyOf = (file) => {
  const header = file.endsWith(".css") ? `/* ${note(file)} */\n` : `// ${note(file)}\n`;
  return header + readFileSync(resolve(source, file), "utf8");
};

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]));
}

const check = process.argv.includes("--check");
const stale = [];
for (const file of FILES) {
  const target = resolve(destination, file);
  const want = copyOf(file);
  const have = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (have === want) continue;
  if (check) stale.push(have === null ? `${file} (missing)` : file);
  else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, want);
  }
}
for (const extra of walk(destination).map((f) => relative(destination, f))) {
  if (FILES.includes(extra)) continue;
  if (check) stale.push(`${extra} (not the app's)`);
  else rmSync(resolve(destination, extra));
}

if (check && stale.length) {
  console.error(`website/components/app is out of step with the app's deck:\n  ${stale.join("\n  ")}\nRun: cd website && npm run sync:app-deck`);
  process.exit(1);
}
console.log(check ? `The app's deck: ${FILES.length} files match.` : `The app's deck: ${FILES.length} files copied.`);
