import { test } from "node:test";
import assert from "node:assert/strict";
import { oldAnchorTarget } from "../components/catalog/oldAnchor.ts";

// An old link to the WISPs page (components/catalog/OldAnchors.tsx) opens the page of a draft the page no longer draws.
// The drafts come as a plain object, by every id an old link may use: an anchor naming a key every object inherits
// must leave the page as it is, like any other unknown anchor, not send it to `/wisps/function Object() { … }`.
const drafts = { "303": "303-keet", "1200": "1200-forward-compat" };

test("a #wisp-… of a draft the page no longer draws opens that draft's page", () => {
  assert.equal(oldAnchorTarget("wisp-303", drafts), "/wisps/303-keet");
  assert.equal(oldAnchorTarget("wisp-1200", drafts), "/wisps/1200-forward-compat");
});

test("a #wisp-… naming an inherited object key leaves the page as it is", () => {
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
    assert.equal(oldAnchorTarget(`wisp-${key}`, drafts), undefined, `#wisp-${key}`);
  }
});

test("an unknown anchor leaves the page; the old inventory anchors open the roadmap", () => {
  assert.equal(oldAnchorTarget("wisp-999", drafts), undefined);
  assert.equal(oldAnchorTarget("glossary", drafts), undefined);
  assert.equal(oldAnchorTarget("inventory", drafts), "/roadmap#inventory-title");
  assert.equal(oldAnchorTarget("candidate-webrtc", drafts), "/roadmap#candidate-webrtc");
});
