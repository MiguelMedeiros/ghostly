import { describe, expect, it } from "vitest";
import { labelMisleads, parseMessage } from "../../lib/parse";

// covers: chat.rich.mdlinks

const link = (text: string) => parseMessage(text).flatMap((b) => (b.type === "paragraph" ? b.segments : [])).find((s) => s.type === "atom");

describe('a link\'s text with a bar that reads as an "l"', () => {
  // The vertical line, divides, Hebrew paseq, the vertical line extension, the broken-circle bar, box drawing light
  // vertical, the light vertical bar, the danda and the halfwidth forms light vertical: a font can draw each as an "l".
  const bars = ["|", "∣", "׀", "⏐", "⏽", "│", "❘", "।", "￨", "｜"];

  it("reads the bar as an l in a host", () => {
    for (const bar of bars) {
      for (const label of [`paypa${bar}.com`, `gmai${bar}.com`]) {
        expect(labelMisleads(label, "https://evil.example/login"), label).toBe(true);
      }
    }
    expect(link("[paypa∣.com](https://evil.example/login)")).toMatchObject({ data: { showUrl: true } });
  });

  it("still reads the bar as a bar when that names another host", () => {
    for (const bar of bars) {
      expect(labelMisleads(`${bar}paypal.com`, "https://lpaypal.com/login"), bar).toBe(true);
      expect(labelMisleads(`secure${bar}paypal.com`, "https://securelpaypal.com/login"), bar).toBe(true);
      expect(labelMisleads(`paypal.com${bar}.secure.net`, "https://paypal.coml.secure.net/login"), bar).toBe(true);
    }
    expect(link("[|paypal.com](https://lpaypal.com/login)")).toMatchObject({ data: { showUrl: true } });
  });

  it("leaves the link's own host, and a bar between words, alone", () => {
    expect(labelMisleads("paypa∣.com", "https://paypal.com")).toBe(false);
    expect(labelMisleads("Docs | ghostly.tools", "https://ghostly.tools/docs")).toBe(false);
    expect(labelMisleads("a | b", "https://evil.example/login")).toBe(false);
  });
});
