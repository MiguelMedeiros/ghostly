import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file) => readFileSync(resolve(root, file), "utf8");

/** The agents FAQ's sentence about a CLI without its WebRTC module. */
function withoutWebRtc() {
  const faq = read("apps/website/content/agents-faq.ts");
  const at = faq.search(/without it the CLI/);
  assert.ok(at >= 0, "the agents FAQ says what the CLI does without WebRTC");
  return faq.slice(at, faq.indexOf(". ", at) + 1);
}

test("the agents FAQ says what stops without WebRTC as the CLI does: calls, not groups", () => {
  // With no RTCPeerConnection (`contactRtc`) a group's links go native (packages/browser/src/engine/node.ts
  // `keepsGroupNative`, WISP 902 § Transports); the CLI's calls need WebRTC (packages/cli/src/runtime/engine.ts).
  const node = read("packages/browser/src/engine/node.ts");
  assert.match(node, /keepsGroupNative[\s\S]*?!this\.contactRtc\(\)/);
  assert.match(node, /private contactRtc\(\): boolean \{\s*return typeof RTCPeerConnection !== "undefined" &&/);
  assert.match(read("packages/cli/src/runtime/engine.ts"), /"Calls need WebRTC, which is off on this headless Ghostly"/);
  const sentence = withoutWebRtc();
  assert.doesNotMatch(sentence, /groups do not work/, `groups work without WebRTC: "${sentence}"`);
  assert.match(sentence, /groups/, `it says groups still work: "${sentence}"`);
  assert.match(sentence, /calls/, `it says calls stop: "${sentence}"`);
});
