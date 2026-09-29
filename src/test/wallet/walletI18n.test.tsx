import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Wallet } from "../../pages/Wallet";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";
import { LANGUAGES, SECTIONS, lookup } from "../i18n/locales";

// covers: app.i18n, wallet.instances.create

/** Something like `wallet.first.title`: what `t()` shows for a key its locale lacks. */
const RAW_KEY = new RegExp(`\\b(?:${SECTIONS.join("|")})(?:\\.[a-zA-Z]+)+\\b`);

describe("the first wallet card speaks the app's language", () => {
  it("in Portuguese", async () => {
    const { engine } = renderApp(<Wallet />, { language: "pt" });
    engine.update({ wallet: walletView({}) });
    const card = await screen.findByTestId("wallet-first");
    expect(card).toHaveTextContent("Crie sua primeira carteira");
    expect(screen.getByTestId("wallet-first-testnet")).toHaveTextContent("Começar na Testnet");
    expect(card).not.toHaveTextContent("Create your first wallet");
  });

  it("in Arabic, with the sentence around New from the translation", async () => {
    const { engine } = renderApp(<Wallet />, { language: "ar" });
    engine.update({ wallet: walletView({}) });
    const card = await screen.findByTestId("wallet-first");
    expect(card).toHaveTextContent("أنشئ محفظتك الأولى");
    const orNew = screen.getByTestId("wallet-first-new").parentElement!;
    expect(orNew.textContent).toBe(lookup("ar", "wallet.first.orNew")!.replace("{{new}}", lookup("ar", "sidebar.new")!));
    expect(card).not.toHaveTextContent(/[A-Za-z]{4,} (?:your|wallet|with)/);
  });

  it.each(LANGUAGES)("in %s, with no raw key", async (language) => {
    const { engine, container } = renderApp(<Wallet />, { language });
    engine.update({ wallet: walletView({}) });
    expect(await screen.findByTestId("wallet-first")).toHaveTextContent(lookup(language, "wallet.first.title")!);
    expect(container.textContent).not.toMatch(RAW_KEY);
  });
});
