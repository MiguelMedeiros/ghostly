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
