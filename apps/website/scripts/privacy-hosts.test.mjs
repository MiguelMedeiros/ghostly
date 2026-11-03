import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file) => readFileSync(resolve(root, file), "utf8");

/** The resolvers a domain lookup may ask, in the order it asks them (`DOH_RESOLVERS`). */
function dohResolvers() {
  const list = read("packages/browser/src/proofs/domain.ts").match(/DOH_RESOLVERS[^=]*=\s*\[([\s\S]*?)\];/);
  assert.ok(list, "DOH_RESOLVERS is in packages/browser/src/proofs/domain.ts");
  return [...list[1].matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** A page's words from "DNS over HTTPS" to the end of that sentence, with JSX whitespace folded. */
function dohSentence(file) {
  const text = read(file).replace(/\s+/g, " ");
  const at = text.search(/DNS[- ]over[- ]HTTPS/);
  assert.ok(at >= 0, `${file} mentions DNS over HTTPS`);
  return text.slice(at, text.indexOf(". ", at) + 1);
}

test("the privacy page and /developers name every resolver a domain lookup may ask, in its order", () => {
  const names = dohResolvers();
  assert.deepEqual(names, ["Quad9", "Cloudflare", "Google"]);
  for (const file of ["apps/website/app/privacy/page.tsx", "apps/website/content/developers.ts"]) {
    const sentence = dohSentence(file);
    const at = names.map((name) => sentence.indexOf(name));
    for (const [i, name] of names.entries()) assert.ok(at[i] >= 0, `${file} names ${name} as a DNS resolver: "${sentence}"`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, `${file} names the resolvers in the order they are asked: "${sentence}"`);
  }
});
