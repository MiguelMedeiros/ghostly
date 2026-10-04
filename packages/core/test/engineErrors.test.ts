import { describe, expect, it } from "vitest";
import { ENGINE_ERRORS, EngineError, engineError, engineText, parseEngineError, type EngineErrorCode } from "../src/engineErrors";

// covers: wallet.cashu.mint.add

/** A value of each kind a template names, as the engine writes it. */
const SAMPLE: Record<string, string> = { wallet: "Bark", device: "Desktop", host: "mint.example.com:3338", domain: "shop.example", chain: "mutinynet", network: "Testnet", amount: "1,000", fee: "12", min: "5", max: "500" };
const CODES = Object.keys(ENGINE_ERRORS) as EngineErrorCode[];
const valuesOf = (code: EngineErrorCode) => Object.fromEntries([...ENGINE_ERRORS[code].matchAll(/\{(\w+)\}/g)].map(([, name]) => [name, SAMPLE[name]]));

describe("the engine's known errors", () => {
  it.each(CODES)("%s: its text reads back as its code and values", (code) => {
    const values = valuesOf(code);
    expect(parseEngineError(engineText(code, values))).toEqual({ code, values });
  });

  it("no text of one code reads as another", () => {
    for (const code of CODES) {
      const text = engineText(code, valuesOf(code));
      for (const other of CODES) if (other !== code) expect(parseEngineError(text)?.code === other, `${code} read as ${other}`).toBe(false);
    }
  });

  it("the texts are the ones the engine always wrote (the CLI and the tests read them)", () => {
    expect(engineText("mintUnreachable", { host: "testnut.cashu.space" })).toBe("Could not reach testnut.cashu.space. Check the address: it should be a Cashu mint.");
    expect(engineText("lnurlRange", { domain: "shop.example", min: "5", max: "500" })).toBe("shop.example takes between 5 and 500 sats");
    expect(engineText("realMoneyUnconfirmed")).toBe("This pays with real money: confirm it with Send real money first. Nothing was sent.");
    const error = engineError("lightningFeeTooHigh", { fee: 12 });
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("The Lightning fee (12 sats) is too high");
    expect(error.engineCode).toBe("lightningFeeTooHigh");
    // Not `code`: the CLI takes a string `code` for its own.
    expect("code" in error).toBe(false);
  });

  it("any other text is not one of them, and keeps its own words", () => {
    expect(parseEngineError("Invoice already paid")).toBeNull();
    expect(parseEngineError("Could not reach the node at that address")).toBeNull();
    expect(parseEngineError("Could not create the Testnet Cashu wallet: Could not reach testnut.cashu.space. Check the address: it should be a Cashu mint. Nothing was saved; try again.")).toBeNull();
    expect(parseEngineError("Not enough sats in your wallet, sorry")).toBeNull();
  });

  it("amounts written in another locale still read back", () => {
    expect(parseEngineError("shop.example takes between 5 and 1.000.000 sats")).toEqual({ code: "lnurlRange", values: { domain: "shop.example", min: "5", max: "1.000.000" } });
  });
});
