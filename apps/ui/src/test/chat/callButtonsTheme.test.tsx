// covers: calls.group.room, calls.audio, app.theme, app.accessibility
import { fireEvent, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string) => undefined) }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({ ...await importOriginal<object>(), invoke: tauri.invoke }));

import { CallOverlay } from "../../components/CallOverlay";
import { GroupCallView, type GroupCallParticipant } from "../../components/GroupCallView";
import type { CallDevices } from "../../hooks/useCallDevices";
import { EMPTY_DEVICES } from "../../lib/mediaDevices";
import { renderApp } from "../render";

/**
 * A call's window follows the theme (`bg-chat-bg`), so its own buttons must too. They were white on a 10 % white tint,
 * drawn for a dark window: on a light theme's pale one the microphone, camera, share, devices and small-window buttons
 * of the group call and the 1:1 call were about 1.0:1, the ⓘ beside them as well, and a tile's muted mark (danger's
 * red on a black tint) 1.1:1. Each at rest takes theme colours: its icon 4.5:1 or more on its fill, and its fill or its
 * edge 3:1 or more on the window and on a tile (the small window draws the buttons over one), in all 8 colour themes.
 */
const SRC = join(fileURLToPath(import.meta.url), "../../..");
const CSS = readFileSync(join(SRC, "index.css"), "utf8");

/** Each theme block's custom properties, by its selector list (as fieldEdge.test.ts reads them). */
function blocks(): { selector: string; vars: Record<string, string> }[] {
  const out: { selector: string; vars: Record<string, string> }[] = [];
  for (const match of CSS.matchAll(/(:root[^{,]*(?:,\s*:root[^{,]*)*)\{([^}]*)\}/g)) {
    const vars: Record<string, string> = {};
    for (const [, name, value] of match[2].matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[name] = value.trim();
    out.push({ selector: match[1].trim(), vars });
  }
  return out;
}

/** The 8 themes (4 colour themes, dark and light): each one's own block over its scheme's base block. */
function themes(): { name: string; vars: Record<string, string> }[] {
  const all = blocks();
  const base = (scheme: "dark" | "light") => all.find(b => scheme === "dark" ? b.selector.startsWith(":root,") : b.selector.startsWith(':root[data-theme="light"],'))!.vars;
  return ["classic", "monochrome", "cyan", "purple"].flatMap(color => (["dark", "light"] as const).map(scheme => {
    const own = all.find(b => b.selector.includes(`[data-theme="${scheme}"][data-color-theme="${color}"]`))!.vars;
    return { name: `${color} ${scheme}`, vars: { ...base(scheme), ...own } };
  }));
}

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** A Tailwind colour name to its colour in one theme, or undefined when the name is no colour of the theme's. */
function resolve(color: string, vars: Record<string, string>): string | undefined {
  const alias = CSS.match(new RegExp(`--color-${color}: var\\(--(theme-[\\w-]+)(?:, var\\(--(theme-[\\w-]+)\\))?\\);`));
  if (!alias) return undefined;
  return vars[alias[1]] ?? (alias[2] ? vars[alias[2]] : undefined);
}

/**
 * The resting colours of an element's classes (no `hover:` or other state): its fill (`bg-`), its ink (`text-`) and
 * its edge (`border-`). A white or black one, with or without a tint, is a colour no theme sets: listed in `fixed`.
 */
function colours(el: Element) {
  const found: { bg?: string; text?: string; border?: string; fixed: string[] } = { fixed: [] };
  for (const cls of el.className.toString().split(/\s+/)) {
    const m = cls.match(/^(bg|text|border)-((?:white|black)(?:\/\d+)?|[a-z][\w-]*)$/);
    if (!m) continue;
    if (/^(white|black)/.test(m[2])) found.fixed.push(cls);
    else if (CSS.includes(`--color-${m[2]}:`)) found[m[1] as "bg" | "text" | "border"] = m[2];
  }
  return found;
}

/**
 * What fails for one control at rest, in every theme. `edge` false: its icon alone tells it (the ⓘ on the window, a
 * tile's muted mark on its own disc), so only the icon's contrast on what is under it counts.
 */
function failures(label: string, el: Element, { edge: bounded = true } = {}): string[] {
  const { bg, text, border, fixed } = colours(el);
  if (fixed.length) return [`${label}: ${fixed.join(" ")} is the same in every theme`];
  if (!text) return [`${label}: no ink of the theme's`];
  if (bounded && !bg) return [`${label}: no fill of the theme's`];
  return themes().flatMap(({ name, vars }) => {
    const window = vars["theme-chat-bg"], tile = vars["theme-surface-hover"];
    const ink = resolve(text, vars)!;
    const under = bg ? resolve(bg, vars)! : window;
    const out: string[] = [];
    const icon = contrast(ink, under);
    if (icon < 4.5) out.push(`${label}, ${name}: ${text} on ${bg ?? "chat-bg"} is ${icon.toFixed(2)}:1`);
    if (bounded) {
      const edge = border ? resolve(border, vars)! : under;
      for (const [where, colour] of [["the window", window], ["a tile", tile]] as const) {
        const ratio = Math.max(contrast(under, colour), contrast(edge, colour));
        if (ratio < 3) out.push(`${label}, ${name}: on ${where} its fill ${bg} and edge ${border ?? "none"} are ${ratio.toFixed(2)}:1`);
      }
    }
    return out;
  });
}

function devices(): CallDevices {
  return {
    list: EMPTY_DEVICES, current: { audioinput: "", videoinput: "", audiooutput: "" }, speaker: undefined, speakers: false,
    choose: vi.fn(), notice: null, dismiss: vi.fn(), switchBack: vi.fn(), hold: vi.fn(),
  };
}

function person(identity: string, over: Partial<GroupCallParticipant> = {}): GroupCallParticipant {
  return { identity, name: identity[0].toUpperCase() + identity.slice(1), mic: true, camera: false, screen: false, speaking: false, tracks: {}, ...over };
}

afterEach(() => {
  localStorage.removeItem("ghostly_group_call_mini");
  localStorage.removeItem("ghostly_call_mini");
});

describe("a call's own buttons in every colour theme", () => {
  it("reads 8 themes from the stylesheet", () => {
    expect(themes()).toHaveLength(8);
  });

  it("the group call: small window, microphone, camera, share, devices (shut and open), the ⓘ and a muted mark", () => {
    // Your screen held by the admin: the ⓘ beside the controls shows, and the microphone and camera stay on.
    const local = person("me", { camera: true, byAdmin: { mic: false, camera: false, screen: true } });
    renderApp(<GroupCallView call={{ local, participants: [person("ana", { mic: false })], activeSpeaker: null }} groupName="Community" canShareScreen
      devices={devices()} onToggleMic={vi.fn()} onToggleCamera={vi.fn()} onToggleScreen={vi.fn()} onLeave={vi.fn()} />);
    const found = [
      ...failures("small window", screen.getByTestId("group-call-minimize")),
      ...failures("microphone", screen.getByTestId("group-call-mic")),
      ...failures("camera", screen.getByTestId("group-call-camera")),
      ...failures("share", screen.getByTestId("group-call-screen")),
      ...failures("devices", screen.getByTestId("call-devices")),
      ...failures("ⓘ", screen.getByTestId("group-call-by-admin-info"), { edge: false }),
      ...failures("muted mark", screen.getByTestId("group-call-muted"), { edge: false }),
    ];
    fireEvent.click(screen.getByTestId("call-devices"));
    expect(screen.getByTestId("call-devices")).toHaveAttribute("aria-expanded", "true");
    found.push(...failures("devices, open", screen.getByTestId("call-devices")));
    expect(found).toEqual([]);
  });

  it("the 1:1 call: small window, microphone, camera, share and devices", () => {
    renderApp(<CallOverlay callState="connected" localStream={null} remoteStream={null} isMuted={false} isVideoOff={false} canSendVideo canShareScreen
      remoteHasVideo={false} callStartedAt={Date.now()} peerName="Ana" devices={devices()}
      onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()} onToggleScreenShare={vi.fn()} />);
    expect(screen.getByTestId("call-camera")).toHaveAttribute("title", "Turn camera off");
    expect([
      ...failures("small window", screen.getByTestId("call-minimize")),
      ...failures("microphone", screen.getByTestId("call-mute")),
      ...failures("camera", screen.getByTestId("call-camera")),
      ...failures("share", screen.getByTestId("share-screen")),
      ...failures("devices", screen.getByTestId("call-devices")),
    ]).toEqual([]);
  });
});
