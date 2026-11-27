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
  // Thai and Lao phinthu, Hebrew hiriq and lower dot, Arabic dot below: on an "l" each draws like U+0323 ("paypaḷcom").
  const marks = ["ฺ", "຺", "ִ", "ׅ", "ٜ"];

  it("reads the mark as the dot between a host's labels", () => {
    for (const mark of marks) {
      const label = `paypal${mark}com`;
      expect(labelMisleads(label, "https://evil.example/login"), label).toBe(true);
      expect(link(`[${label}](https://evil.example/login)`), label).toMatchObject({ data: { showUrl: true } });
    }
  });

  it('reads the mark as a dot on a letter of its own script that looks like an "l" in a Latin word', () => {
    // Thai lakkhangyao, Hebrew vav and final nun, Arabic alef (and its isolated form) are a plain stroke.
    const strokes = ["ๅฺ", "וִ", "וׅ", "וְִ", "ןׅ", "اٜ", "ﺍٜ"];
    for (const stroke of strokes) {
      const label = `paypa${stroke}com`;
      expect(labelMisleads(label, "https://evil.example/login"), label).toBe(true);
    }
    // Digits are no script's letters: "1.2.3.4".
    expect(labelMisleads("1ฺ2ฺ3ฺ4", "https://evil.example/login")).toBe(true);
  });

  it("reads the mark as a dot on such a letter set off by a narrow space on each side, which reads as no gap", () => {
    const labels = [
      "paypa\u200a\u0e45\u0e3a\u200acom",
      "paypa\u2009\u0e45\u0e3a\u2009com",
      "paypa\u2006\u05d5\u05b4\u2006com",
      "paypa\u202f\u0627\u065c\u202fcom",
      "paypa\u200a\u05df\u05c5\u200acom",
    ];
    for (const label of labels) {
      expect(labelMisleads(label, "https://evil.example/login"), label).toBe(true);
    }
  });

  it("leaves the mark alone in a word of its own script", () => {
    for (const label of ["ภิกฺขุ", "שִׁיר חָדָשׁ", "שׁלֹמֹהׅ ודוד", "بٜسم الله", "ธมฺม Dhamma", "שִׁיר song", "ພຸດ຺ທະ"]) {
      expect(labelMisleads(label, "https://evil.example/login"), label).toBe(false);
    }
  });
});

describe("a link's text with several dots below on one letter", () => {
  it("reads them as one dot between a host's labels", () => {
    const labels = ["paypaḷฺcom", "paypalฺฺcom", "paypaḷ̣com", "paypaḷ̣com"];
    // Or a dot below beside a written dot: "paypaḷ.com".
    for (const label of [...labels, "paypaḷ.com", "paypal.̣com"]) {
      expect(labelMisleads(label, "https://evil.example/login"), label).toBe(true);
    }
  });

  it("reads a long run of them at once", () => {
    const run = "̣".repeat(200);
    expect(labelMisleads(`paypal${run}com`, "https://evil.example/login")).toBe(true);
    expect(labelMisleads(`paypal${run}`, "https://evil.example/login")).toBe(false);
  });

  it("leaves a run of written dots alone", () => {
    expect(labelMisleads("wait...what", "https://evil.example/login")).toBe(false);
  });
});
