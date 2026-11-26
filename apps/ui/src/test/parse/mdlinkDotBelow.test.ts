import { describe, expect, it } from "vitest";
import { labelMisleads, parseMessage } from "../../lib/parse";

// covers: chat.rich.mdlinks

const link = (text: string) => parseMessage(text).flatMap((b) => (b.type === "paragraph" ? b.segments : [])).find((s) => s.type === "atom");

describe("a link's text with a letter that has a dot below", () => {
  // One letter ("ḷ", U+1E37) draws the same as the letter and a combining dot below ("l" + U+0323).
  const labels = ["paypaḷcom", "googlẹcom", "amazoṇcom", "ghostlẹtools"];

  it("reads the dot as the dot between a host's labels, written as one letter or as two", () => {
    for (const label of [...labels, ...labels.map((l) => l.normalize("NFD"))]) {
      expect(labelMisleads(label, "https://evil.example/login"), label).toBe(true);
    }
    expect(link("[paypaḷcom](https://evil.example/login)")).toMatchObject({ data: { showUrl: true } });
  });

  it("leaves the link's own host and words without a host alone", () => {
    expect(labelMisleads("ghostlỵtools", "https://ghostly.tools")).toBe(false);
    expect(labelMisleads("Họ tên", "https://evil.example/login")).toBe(false);
  });
});

describe("a link's text with another script's dot below on a letter", () => {
  // Thai phinthu, Hebrew hiriq and lower dot, Arabic dot below: on an "l" each draws like U+0323 ("paypaḷcom").
  const marks = ["ฺ", "ִ", "ׅ", "ٜ"];

  it("reads the mark as the dot between a host's labels", () => {
    for (const mark of marks) {
      const label = `paypal${mark}com`;
      expect(labelMisleads(label, "https://evil.example/login"), label).toBe(true);
      expect(link(`[${label}](https://evil.example/login)`), label).toMatchObject({ data: { showUrl: true } });
    }
  });

  it("leaves the mark alone on a letter of its own script", () => {
    expect(labelMisleads("ภิกฺขุ", "https://evil.example/login")).toBe(false);
    expect(labelMisleads("שִׁיר חָדָשׁ", "https://evil.example/login")).toBe(false);
    expect(labelMisleads("שׁלֹמֹהׅ ודוד", "https://evil.example/login")).toBe(false);
    expect(labelMisleads("بٜسم الله", "https://evil.example/login")).toBe(false);
  });
});
