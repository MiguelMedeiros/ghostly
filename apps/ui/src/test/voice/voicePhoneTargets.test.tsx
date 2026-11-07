import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { renderApp } from "../render";
import { installFakeAudio, installFakeMedia, removeFakeMedia } from "./fakeMedia";

// covers: files.voice.record, app.mobile-layout

/**
 * On a phone the hands-free recorder's bar gives a thumb 44 × 44 px where a tap lands, as the rest of the app does:
 * the bin, Pause / Resume and the preview's Play / Pause were 36 × 36 px, and the Discard question's Keep and Discard
 * 34 px tall. They carry `.tap-target` (index.css), which grows where a tap lands past the box without moving the bar;
 * the measure itself is a browser's (e2e/web/phone-touch-targets.spec.ts).
 */
const VOICE_CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../components/voice/voice.css"), "utf8");

const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

async function handsFree(ms: number) {
  renderApp(<MessageInput onSend={vi.fn().mockResolvedValue(null)} onSendFile={vi.fn().mockResolvedValue(null)} />);
  fireEvent.click(screen.getByTestId("voice-record"));
  await wait(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeMedia();
  installFakeAudio();
});

afterEach(() => {
  vi.useRealTimers();
  removeFakeMedia();
  vi.restoreAllMocks();
});

describe("the voice recorder's bar on a phone", () => {
  it("recording: the bin and Pause are thumb-sized", async () => {
    await handsFree(1_000);
    expect(screen.getByTestId("voice-delete")).toHaveClass("tap-target");
    expect(screen.getByRole("button", { name: "Pause" })).toHaveClass("tap-target");
  });

  it("paused: the bin, the preview's Play / Pause and Resume are thumb-sized", async () => {
    await handsFree(2_000);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-phase", "paused");
    expect(screen.getByTestId("voice-delete")).toHaveClass("tap-target");
    expect(screen.getByRole("button", { name: "Play" })).toHaveClass("tap-target");
    expect(screen.getByRole("button", { name: "Resume" })).toHaveClass("tap-target");
    fireEvent.click(screen.getByTestId("voice-preview"));
    await wait(500);
    expect(screen.getByRole("button", { name: "Pause playback" })).toHaveClass("tap-target");
  });

  it("the Discard question after Esc: Keep and Discard are thumb-sized", async () => {
    await handsFree(4_000);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("alertdialog", { name: "Discard voice message?" })).toBeInTheDocument();
    expect(screen.getByTestId("voice-confirm-keep")).toHaveClass("tap-target");
    expect(screen.getByTestId("voice-confirm-discard")).toHaveClass("tap-target");
  });

  it("nothing in the bar clips that larger area, and the buttons draw no ::after of their own", () => {
    const rule = (selector: string) => VOICE_CSS.match(new RegExp(`^${selector.replace(/[.-]/g, "\\$&")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    for (const holder of [".voice-bar", ".voice-confirm"]) {
      expect(rule(holder), holder).not.toBe("");
      expect(rule(holder), holder).not.toMatch(/overflow|clip-path|contain:/);
    }
    expect(VOICE_CSS).not.toMatch(/\.voice-(icon|text)-button[^{]*::after/);
  });
});
