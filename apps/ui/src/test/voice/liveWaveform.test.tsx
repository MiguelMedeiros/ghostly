import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveWaveform } from "../../components/voice/Waveform";

const CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../components/voice/voice.css"), "utf8");

// covers: files.voice.record

describe("the live waveform", () => {
  it("draws its bars with a transform, so a new reading lays nothing out", () => {
    const { getByTestId } = render(<LiveWaveform levels={[0, 0.5, 2]} bars={3} />);
    const bars = [...getByTestId("voice-live").querySelectorAll("span")];
    expect(bars.map((bar) => bar.style.transform)).toEqual(["scaleY(0.08)", "scaleY(0.5)", "scaleY(1)"]);
    expect(bars.map((bar) => bar.style.height)).toEqual(["", "", ""]);
  });

  it("keeps the newest reading on the right in a right-to-left language, like the preview and the sent bubble", () => {
    // The bars are a flex row ending at flex-end: its direction is the nearest dir, so under an Arabic page it would
    // put the newest at the left and turn around when the recording stops.
    const { getByTestId } = render(<div dir="rtl"><LiveWaveform levels={[0.1, 0.9]} bars={2} /></div>);
    const newest = [...getByTestId("voice-live").querySelectorAll("span")][1]!;
    expect(newest.style.transform).toBe("scaleY(0.9)");
    expect(newest.closest("[dir]")!.getAttribute("dir")).toBe("ltr");
  });

  it("does not animate its bars: readings come faster than a transition ends, and each frame would be drawn", () => {
    const rule = /\.voice-live span \{([^}]*)\}/.exec(CSS)![1]!;
    expect(rule.replace(/\/\*[^]*?\*\//g, "")).not.toMatch(/transition/);
  });
});
