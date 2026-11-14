import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file) => readFileSync(resolve(root, file), "utf8");

/** The negotiation demo's line under the loop (`negotiation.first`). */
function firstLine() {
  const line = read("apps/website/content/developers.ts").match(/^\s*first:\s*"([^"]*)",$/m);
  assert.ok(line, "negotiation.first is in apps/website/content/developers.ts");
  return line[1];
}

test("/developers says a first pairing dials Iroh and HyperDHT too, as the engine does", () => {
  // Before the pin the capability record, native descriptors and all, is sealed with the invite key, and an inviter
  // with no offer of the joiner's to wait for (WebRTC missing on either side) dials a native transport it describes.
  assert.match(read("packages/core/src/capsRecord.ts"), /peerKey \? this\.pinnedKey\(peerKey\) : this\.inviteKey/);
  assert.match(read("packages/core/src/ghostlink.ts"), /private nothingToAwait\(\): boolean/);
  const line = firstLine();
  assert.doesNotMatch(line, /WebRTC only/, `a first pairing is not WebRTC only: "${line}"`);
  assert.match(line, /^A first pairing dials WebRTC, and Iroh and HyperDHT when WebRTC is missing on either side or connects nothing/, line);
  assert.match(line, /sealed with the invite key until the pin/, line);
});
