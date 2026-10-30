import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../lib/types";
import { DETECT_CHARS, detectableText, translateFrom, type LanguageGuess } from "../../lib/translateWhich";

// covers: app.i18n

/*
 * Which received messages get translated, and from which language (docs/AUTO-TRANSLATE.md § Source language). The
 * detector is a fake answering per text, so each rule is tested apart from what the real one guesses.
 */

const received = (text: string, more: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m", text, sender: "peer", timestamp: 1, ...more });

function setup(guesses: Record<string, LanguageGuess[]> = {}, fallback: LanguageGuess[] = [{ code: "pt", probability: 0.9 }]) {
  const asked: string[] = [];
  const detect = (text: string) => {
    asked.push(text);
    return guesses[text] ?? fallback;
  };
  const options = { appLanguage: "en" as const, detect, canTranslate: (language: string) => language !== "vo" };
  return { asked, options };
}

describe("translateFrom", () => {
  it("translates a received text the detector is sure is in another language", () => {
    const { options } = setup({ "Chego aí em minutos, tô preso no trânsito.": [{ code: "pt", probability: 0.93 }] });
    expect(translateFrom(received("Chego aí em 10 minutos, tô preso no trânsito."), options)).toEqual({ from: "pt", detected: "pt" });
  });

  it("never translates my own messages or system lines, and does not run the detector for them", () => {
    const { asked, options } = setup();
    expect(translateFrom(received("Mandei o arquivo no grupo", { sender: "me" }), options)).toEqual({ from: null, detected: null });
    expect(translateFrom(received("Alice entrou no grupo", { sender: "system" }), options)).toEqual({ from: null, detected: null });
    expect(asked).toEqual([]);
  });

  it("leaves files, payments, status cards and call lines alone, whatever their text says", () => {
    const { asked, options } = setup();
    const file = { id: "f", name: "relatório.pdf", size: 1, mime: "application/pdf" };
    const card = { v: 1, kind: "task", id: "t", title: "Revisar o contrato" } as unknown as ChatMessage["card"];
    for (const message of [
      received("relatório final do mês", { file }),
      received("Pagamento do aluguel", { paymentId: "p" }),
      received("Revisar o contrato hoje", { card }),
      received("Chamada perdida de voz", { callEvent: { type: "missed" as never } }),
    ]) expect(translateFrom(message, options).from).toBeNull();
    expect(asked).toEqual([]);
  });

  it("does not translate a message in the app's language, but says which language it is", () => {
    const { options } = setup({}, [{ code: "en", probability: 0.97 }]);
    expect(translateFrom(received("I'll be there in ten minutes"), options)).toEqual({ from: null, detected: "en" });
  });

  it("compares the detected language by its base code, in any case", () => {
    const { options } = setup({}, [{ code: "EN-us", probability: 0.97 }]);
    expect(translateFrom(received("I'll be there in ten minutes"), options)).toEqual({ from: null, detected: "en" });
  });

  it("does not translate what the detector cannot tell", () => {
    expect(translateFrom(received("hmmm okay then"), setup({}, [{ code: "und", probability: 1 }]).options)).toEqual({ from: null, detected: null });
    expect(translateFrom(received("hmmm okay then"), setup({}, []).options)).toEqual({ from: null, detected: null });
  });

  it("needs a probability of 0.5 or more", () => {
    expect(translateFrom(received("Bom dia pessoal"), setup({}, [{ code: "pt", probability: 0.49 }]).options)).toEqual({ from: null, detected: null });
    expect(translateFrom(received("Bom dia pessoal"), setup({}, [{ code: "pt", probability: 0.5 }]).options)).toEqual({ from: "pt", detected: "pt" });
  });

  it("shows nothing for a language there is no model for, but still says which it is", () => {
    const { options } = setup({}, [{ code: "vo", probability: 0.8 }]);
    expect(translateFrom(received("lol no way at all"), options)).toEqual({ from: null, detected: "vo" });
  });

  it("does not translate under 4 letters, counted after emoji, links, numbers and mentions are taken out", () => {
    const { asked, options } = setup();
    for (const text of ["ok", "sim 😂😂😂", "https://example.com/a-long-path-here ok", "123456 ok", "kkk 2025"]) {
      expect(translateFrom(received(text), options)).toEqual({ from: null, detected: null });
    }
    const mention = received("@Mariana oi", { mentions: [{ o: 0, l: 8, key: "k", name: "Mariana", me: false }] });
    expect(translateFrom(mention, options)).toEqual({ from: null, detected: null });
    expect(asked).toEqual([]);
  });

  it("takes a short message as the chat's language when the chat has one", () => {
    const { asked, options } = setup();
    expect(translateFrom(received("sì 👍"), { ...options, chatLanguage: "it" })).toEqual({ from: "it", detected: null });
    expect(translateFrom(received("ok"), { ...options, chatLanguage: "en" })).toEqual({ from: null, detected: null });
    expect(translateFrom(received("ok"), { ...options, chatLanguage: "vo" })).toEqual({ from: null, detected: null });
    expect(asked).toEqual([]);
  });

  it("does not translate a message with no letters at all, whatever the chat's language", () => {
    const { options } = setup();
    for (const text of ["😂😂", "42", "https://example.com"]) {
      expect(translateFrom(received(text), { ...options, chatLanguage: "it" }).from).toBeNull();
    }
  });

  it("does not translate a message that is JSON", () => {
    const { asked, options } = setup();
    expect(translateFrom(received('{"nome": "Ana", "cidade": "Lisboa"}'), options).from).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("detectableText", () => {
  it("keeps the words and drops code, links, tokens, invoices, addresses and other codes", () => {
    const text = [
      "Olha o código `npm run build` e o link https://ghostly.tools/docs aqui",
      "```ts\nconst x = 1;\n```",
      "paga cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8vbWludC5leGFtcGxlIn1dfQ esta fatura lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfq ou bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      "e entra ghostly1qy8z9x0w7v6u5t4s3r2q no grupo",
    ].join("\n");
    expect(detectableText(text)).toBe("Olha o código e o link aqui paga esta fatura ou e entra no grupo");
  });

  it("keeps the text of formatting, lists, quotes and headings", () => {
    expect(detectableText("# Lista\n- *pão* e _leite_\n> não esquece")).toBe("Lista pão e leite não esquece");
  });

  it("takes a mention out by its place, not by its text", () => {
    expect(detectableText("@Ana Lima chega amanhã", [{ o: 0, l: 9 }])).toBe("chega amanhã");
  });

  it("takes numbers out of text with no spaces without dropping the words around them", () => {
    expect(detectableText("我今天10点到")).toBe("我今天 点到");
  });

  it("drops emoji", () => {
    expect(detectableText("lol no way 😂👍🏽❤️")).toBe("lol no way");
  });

  it(`hands the detector at most ${DETECT_CHARS} characters`, () => {
    const { asked, options } = setup();
    translateFrom(received("palavra ".repeat(2_000)), options);
    expect(asked[0].length).toBeLessThanOrEqual(DETECT_CHARS);
  });
});
