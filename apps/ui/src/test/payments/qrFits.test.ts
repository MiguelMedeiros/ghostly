import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { QRCodeSVG } from "qrcode.react";
import { describe, expect, it } from "vitest";
import { qrFits } from "../../lib/qrFits";

// covers: payments.cashu.token-card, payments.lightning.invoice-card

const draws = (value: string) => {
  try {
    renderToString(createElement(QRCodeSVG, { value, level: "L" }));
    return true;
  } catch {
    return false;
  }
};

describe("qrFits", () => {
  // Each mode's last length that fits and the first that does not, checked against qrcode.react itself.
  it.each([
    ["digits", "1", 7089],
    ["an upper-cased invoice", "LIGHTNING:LNBC1", 4296],
    ["an ecash token", "cashuBo", 2953],
    ["text beyond ASCII", "é", 1476],
  ])("agrees with qrcode.react at the edge for %s", (_, unit, edge) => {
    const at = (n: number) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    expect(qrFits(at(edge))).toBe(true);
    expect(draws(at(edge))).toBe(true);
    expect(qrFits(at(edge + 1))).toBe(false);
    expect(draws(at(edge + 1))).toBe(false);
  });
});
