import { bech32 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { findMoney } from "../../lib/money";

// covers: payments.lnurl.card

const LNURL = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode("https://ln.example.com/lnurlp/alice")), 2048);
// Written as escapes: the left-to-right, right-to-left and Arabic letter marks draw as nothing.
const LRM = "\u200e", RLM = "\u200f", ALM = "\u061c";
const destination = (text: string) => {
  const money = findMoney(text);
  return money?.type === "lnurl" ? money.destination : null;
};

describe("an LNURL or a Lightning address ends where a link would", () => {
  it("gets its card before Chinese, Japanese or Arabic punctuation and a direction mark", () => {
    expect(findMoney(`ادفع ${LNURL}${RLM}.`)?.type).toBe("lnurl");
    expect(findMoney(`払って ${LNURL}。`)?.type).toBe("lnurl");
    for (const after of ["、", "،", "؟", LRM, RLM, ALM]) {
      expect(destination(`pay ${LNURL}${after} thanks`), JSON.stringify(after)).toMatchObject({ kind: "lnurl", url: "https://ln.example.com/lnurlp/alice" });
    }
  });

  it("gets its card as a whole message ended by a direction mark", () => {
    for (const mark of [LRM, RLM, ALM, `${RLM}${LRM}`]) {
      expect(destination(`⚡alice@example.com${mark}`), JSON.stringify(mark)).toMatchObject({ kind: "address", text: "alice@example.com" });
      expect(destination(`${LNURL}${mark}`), JSON.stringify(mark)).toMatchObject({ kind: "lnurl" });
    }
  });

  it("still gets it before a plain full stop, and without anything after it", () => {
    expect(findMoney(`pay ${LNURL}.`)?.type).toBe("lnurl");
    expect(destination("⚡alice@example.com")).toMatchObject({ kind: "address", text: "alice@example.com" });
  });

  it("gets none for a mark inside it, rather than a shorter address that still reads as one", () => {
    for (const mark of [LRM, RLM, ALM]) {
      expect(destination(`⚡alice@example.com${mark}.evil.example`), JSON.stringify(mark)).toBeNull();
      expect(destination(`⚡alice@exam${mark}ple.com`), JSON.stringify(mark)).toBeNull();
      expect(destination(`pay ${LNURL.slice(0, 20)}${mark}${LNURL.slice(20)} now`), JSON.stringify(mark)).toBeNull();
    }
  });
});
