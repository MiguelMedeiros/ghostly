import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file) => readFileSync(resolve(root, file), "utf8");

/** The number a pattern captures in a core source file. */
function seconds(file, pattern) {
  const found = read(file).match(pattern);
  assert.ok(found, `${pattern} is in ${file}`);
  return found[1];
}

test("/developers gives each Pkarr record the TTL core publishes it with", () => {
  const sentence = read("apps/website/content/developers.ts").match(/"Signed Pkarr records:[^"]*"/)?.[0];
  assert.ok(sentence, "content/developers.ts has the Signed Pkarr records line");
  const ttls = {
    default: seconds("packages/core/src/pkarr.ts", /DEFAULT_TTL = (\d+);/),
    _caps: seconds("packages/core/src/capsRecord.ts", /label: CAPS_LABEL,[^\n]*ttl: (\d+) \}/),
    "did:dht": seconds("packages/core/src/didDht.ts", /DID_DHT_TTL = (\d+);/),
  };
  assert.match(sentence, new RegExp(`${ttls.default} seconds by default`));
  assert.match(sentence, new RegExp(`${ttls._caps} for _caps`));
  assert.match(sentence, new RegExp(`${ttls["did:dht"]} for did:dht`));
});
