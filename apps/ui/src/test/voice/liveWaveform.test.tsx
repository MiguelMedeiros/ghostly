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

  it("does not animate its bars: readings come faster than a transition ends, and each frame would be drawn", () => {
    const rule = /\.voice-live span \{([^}]*)\}/.exec(CSS)![1]!;
    expect(rule.replace(/\/\*[^]*?\*\//g, "")).not.toMatch(/transition/);
  });
});
