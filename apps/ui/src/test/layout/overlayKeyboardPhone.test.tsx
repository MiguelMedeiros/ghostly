import { act, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { NostrDraft, NostrDraftRequest } from "@ghostly/browser/nostr/types";
import { DeleteProfileDialog } from "../../components/DeleteProfileDialog";
import { NostrPublishDialog } from "../../components/nostr/NostrPublishDialog";
import { StatusPickerHost } from "../../components/StatusPicker";
import { openStatusPicker } from "../../lib/ownStatus";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.mobile-layout, chat.status.picker, profiles.delete, nostr.social.publish

/*
 * A phone held upright with the keyboard up: iOS keeps the page's height, and a dialog that is not a <dialog> (a panel
 * in a layer over the whole screen) stayed centred on all of it. Set status, Delete profile and Nostr publish open
 * with a field, so their Save, Delete and Sign and publish sat under the keyboard: the rule that makes the layer end
 * where the keyboard starts was only from 768px (a phone on its side, a tablet). happy-dom lays nothing out, so this
 * reads the rule from index.css, checks the screens it applies to, and that these three dialogs are what it styles.
 * The real proof is e2e/web/phone-dialogs.spec.ts.
 */

vi.mock("../../lib/nostr", () => ({
  nostrSignerChoices: () => [{ id: "nip07", label: "Browser extension (NIP-07)" }],
  signNostrDraft: vi.fn(async () => ({ id: "signed" })),
}));

const css = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every style rule with the @media conditions around it. */
function rules(source: string) {
  const found: { media: string[]; selector: string; body: string }[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "{") {
      const prelude = source.slice(start, i).trim();
      if (prelude.startsWith("@")) { stack.push(prelude); start = i + 1; continue; }
      const end = source.indexOf("}", i);
      found.push({ media: stack.filter((at) => at.startsWith("@media")), selector: prelude, body: source.slice(i + 1, end) });
      i = end;
      start = end + 1;
    } else if (source[i] === "}") {
      stack.pop();
      start = i + 1;
    } else if (source[i] === ";" && source.slice(start, i).trim().startsWith("@")) {
      start = i + 1;
    }
  }
  return found;
}

type Screen = { width: number; height: number; pointer: "coarse" | "fine" };
/** Whether `@media <query>` holds on that screen; only the features index.css uses. */
function holds(query: string, at: Screen) {
  return query.replace(/^@media\s*/, "").split(/\s*,\s*/).some((part) => part.split(/\s+and\s+/).every((test) => {
    const [, feature, value] = /^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/.exec(test.trim()) ?? [];
    const px = parseFloat(value);
    switch (feature) {
      case "pointer": return value === at.pointer;
      case "min-width": return at.width >= px;
      case "max-width": return at.width <= px;
      case "min-height": return at.height >= px;
      case "max-height": return at.height <= px;
      default: return false;
    }
  }));
}

const KEYBOARD_UP = 'html[data-keyboard="true"] ';
/** The rules that end a hand-made dialog's layer where the keyboard starts, and cap its panel to that layer. */
const layerRules = rules(css).filter((rule) => rule.selector.startsWith(`${KEYBOARD_UP}.fixed.inset-0:has(> [aria-modal="true"]`) && /bottom:\s*calc\(100% - var\(--app-height/.test(rule.body));
const panelRules = rules(css).filter((rule) => rule.selector.startsWith(`${KEYBOARD_UP}.fixed.inset-0 > [aria-modal="true"]`) && /max-height:\s*100%/.test(rule.body));
const on = (list: typeof layerRules, at: Screen) => list.filter((rule) => rule.media.every((query) => holds(query, at))).map((rule) => rule.selector.slice(KEYBOARD_UP.length));

const UPRIGHT: Screen = { width: 390, height: 844, pointer: "coarse" };
const SMALL: Screen = { width: 320, height: 568, pointer: "coarse" };
const SIDE: Screen = { width: 874, height: 402, pointer: "coarse" };
const TABLET: Screen = { width: 1133, height: 744, pointer: "coarse" };

describe("a dialog that is not a <dialog>, with the keyboard up", () => {
  it("ends where the keyboard starts on a phone held upright too, as on its side and on a tablet", () => {
    expect(layerRules.length).toBeGreaterThan(0);
    for (const at of [UPRIGHT, SMALL, SIDE, TABLET]) {
      expect(on(layerRules, at), `${at.width}×${at.height}`).not.toEqual([]);
      expect(on(panelRules, at), `${at.width}×${at.height}`).not.toEqual([]);
    }
  });

  it("is left as it is on a mouse's screen, where no keyboard covers it", () => {
    for (const at of [{ ...UPRIGHT, pointer: "fine" as const }, { width: 1280, height: 800, pointer: "fine" as const }]) {
      expect(on(layerRules, at)).toEqual([]);
      expect(on(panelRules, at)).toEqual([]);
    }
  });

  it("leaves a phone's sheet to its own rule: it stands on the keyboard already, and its cap is not lifted", () => {
    const layer = document.body.appendChild(document.createElement("div"));
    try {
      layer.className = "fixed inset-0";
      layer.innerHTML = '<div role="dialog" aria-modal="true" class="sheet sheet-padded"></div>';
      const sheet = layer.firstElementChild!;
      for (const selector of on(layerRules, UPRIGHT)) expect(layer.matches(selector), selector).toBe(false);
      for (const selector of on(panelRules, UPRIGHT)) expect(sheet.matches(selector), selector).toBe(false);
      // From 768px the same panel is a centred dialog again, and the rule takes it.
      expect(on(layerRules, SIDE).some((selector) => layer.matches(selector))).toBe(true);
    } finally {
      layer.remove();
    }
  });

  /** The dialog's layer and panel are what the phone's rules style. */
  function styledOnPhone(panel: HTMLElement) {
    const layer = panel.parentElement!;
    expect(on(layerRules, UPRIGHT).some((selector) => layer.matches(selector)), "its layer").toBe(true);
    expect(on(panelRules, UPRIGHT).some((selector) => panel.matches(selector)), "its panel").toBe(true);
  }

  it("Set status: its layer and panel take the rule, so Save is above the keyboard", async () => {
    fakeEngine.on("getOwnStatus", () => ({ sharePresence: true }));
    renderApp(<StatusPickerHost />);
    act(() => openStatusPicker());
    styledOnPhone(await screen.findByTestId("status-picker"));
  });

  it("Delete profile: its layer and panel take the rule, so Delete is above the keyboard", () => {
    renderApp(<DeleteProfileDialog entry={{ id: "abcdefghij", name: "Work", createdAt: 0 }} onClose={() => {}} />);
    styledOnPhone(screen.getByTestId("delete-profile"));
  });

  it("Nostr publish: its layer and panel take the rule, so Sign and publish is above the keyboard", async () => {
    fakeEngine.on("nostrDraft", async () => ({ draftId: "d1", subject: "npub1me", template: { kind: 1, created_at: 1, tags: [], content: "hi" }, notice: "Sent to wss://relay.example.", summary: "Post a note", relays: ["wss://relay.example"] }) as NostrDraft);
    const request: NostrDraftRequest = { subject: "npub1me", action: "note", content: "hi" };
    renderApp(<NostrPublishDialog request={request} onClose={() => {}} />);
    styledOnPhone(await screen.findByTestId("nostr-publish-dialog"));
  });
});
