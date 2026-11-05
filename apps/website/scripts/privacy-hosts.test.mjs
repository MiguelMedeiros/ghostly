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

/** The hosts of a default relay list (`name = [ "https://…", … ]`) in a source file. */
function defaultHosts(file, name) {
  const list = read(file).match(new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(list, `${name} is in ${file}`);
  return [...list[1].matchAll(/"(https:\/\/[^"]+)"/g)].map((m) => new URL(m[1]).hostname);
}

test("the privacy page and the agents FAQ name the default relays the project runs, and the FAQ how to replace them", () => {
  const pkarr = defaultHosts("packages/core/src/relay.ts", "DEFAULT_RELAYS");
  const iroh = defaultHosts("packages/browser/src/platform/irohWeb.ts", "DEFAULT_IROH_RELAYS");
  const own = [...pkarr, ...iroh].filter((host) => host.endsWith(".miguelmedeiros.dev"));
  assert.deepEqual(own, ["pkarr.miguelmedeiros.dev", "iroh.miguelmedeiros.dev"]);
  const faq = read("apps/website/content/agents-faq.ts");
  for (const file of ["apps/website/app/privacy/page.tsx", "apps/website/content/agents-faq.ts"]) {
    for (const host of own) assert.ok(read(file).includes(host), `${file} names ${host}`);
  }
  for (const name of ["GHOSTLY_PKARR_RELAYS", "GHOSTLY_IROH_RELAYS"]) assert.ok(faq.includes(name), `the agents FAQ names ${name}`);
  assert.doesNotMatch(faq, /no Ghostly server in the path|Nothing goes to a Ghostly server/);
  // The CLI's Iroh is the wasm build, relay only (packages/cli/src/runtime/engine.ts): never a direct path.
  const direct = faq.match(/directly over (?:\w+(?:, | or ))*\w+/g) ?? [];
  assert.ok(direct.length, "the agents FAQ says how the two ends connect directly");
  for (const ways of direct) assert.doesNotMatch(ways, /Iroh/, `the CLI's Iroh is never direct: "${ways}"`);
});

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
