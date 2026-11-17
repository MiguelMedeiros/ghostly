import { describe, expect, it } from "vitest";
import { previewableLink } from "../../lib/parse/linkPreview";
import { locationIn } from "../../lib/parse/location";
import { findBip21 } from "../../lib/parse/money-bitcoin";
import { insideUrl } from "../../lib/parse/money-text";

// covers: chat.link-preview.compose, chat.location.card, payments.money.onchain-card

// The bubble ends a link at the first "。", "،"… (LINK_STOP_CHARS) and reads what follows as a link of its own. The
// scanners behind the preview, the location card and the payment card read one run to the next space instead.

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const STOPS = ["、", "،", "؟"];

describe("a place written right after a link's 。 or ، with no space", () => {
  it("gets its card, as the bubble reads it", () => {
    expect(locationIn("見て https://a.example/x。geo:37.78,-122.41")).toMatchObject({ lat: 37.78, lon: -122.41, source: "geo:37.78,-122.41" });
    for (const stop of STOPS)
      expect(locationIn(`https://a.example/x${stop}geo:37.78,-122.41`), stop).toMatchObject({ lat: 37.78, lon: -122.41 });
    expect(locationIn("見て https://a.example/x。https://www.openstreetmap.org/#map=12/38.6916/-9.2160")).toMatchObject({ lat: 38.6916, lon: -9.216 });
  });

  it("is read whole where the bubble reads on: a name in Japanese, a full-width full stop, a space", () => {
    expect(locationIn("https://maps.apple.com/?ll=35.6586,139.7454&q=東京タワー")).toMatchObject({ lat: 35.6586, name: "東京タワー" });
    // \uff0e is no stop (a host can be written with it): the bubble draws one link, and no place is read out of it.
    expect(locationIn("https://a.example/x\uff0egeo:37.78,-122.41")).toBeNull();
    expect(locationIn("見て https://a.example/x geo:37.78,-122.41")).toMatchObject({ lat: 37.78, lon: -122.41 });
  });
});

describe("a payment link written right after a web link's 。 or ، with no space", () => {
  it("is outside the web link, as the bubble reads it", () => {
    const text = `見て https://x.example/a。bitcoin:${ADDRESS}`;
    expect(insideUrl(text, text.indexOf("bitcoin:"))).toBe(false);
    expect(findBip21(text)[0].address).toBe(ADDRESS);
    for (const stop of STOPS) {
      const after = `https://x.example/a${stop}bitcoin:${ADDRESS}`;
      expect(insideUrl(after, after.indexOf("bitcoin:")), stop).toBe(false);
    }
  });

  it("stays inside it within the link's own run: a path in Japanese, a full-width full stop", () => {
    for (const text of [`https://x.example/東京?u=bitcoin:${ADDRESS}`, `https://x.example/a\uff0ebitcoin:${ADDRESS}`]) {
      expect(insideUrl(text, text.indexOf("bitcoin:")), text).toBe(true);
      expect(findBip21(text), text).toEqual([]);
    }
    const spaced = `https://x.example/a bitcoin:${ADDRESS}`;
    expect(insideUrl(spaced, spaced.indexOf("bitcoin:"))).toBe(false);
  });
});

describe("a web link written right after another one's 。 with no space", () => {
  it("may get the preview: the bubble draws it, and the person wrote it", () => {
    expect(previewableLink("見て https://i.example/cat.gif。https://news.example/a")).toBe("https://news.example/a");
    expect(previewableLink("見て https://i.example/cat.gif https://news.example/a")).toBe("https://news.example/a");
  });

  it("never the two links glued together, an address nobody wrote", () => {
    expect(previewableLink("見て https://news.example/a。https://other.example/b")).toBe("https://news.example/a");
  });
});
