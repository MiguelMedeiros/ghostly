import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ComposerSheet } from "../../components/ComposerSheet";
import { ConnectionHistory } from "../../components/TransportTimeline";
import { GroupChat } from "../../pages/GroupChat";
import { Home } from "../../pages/Home";
import { fakeEngine, groupView } from "../fakeEngine";
import { lookup } from "../i18n/locales";
import { renderApp } from "../render";

// covers: app.i18n, payments.chat.cards, wallet.instances.create, app.home, groups.link.join, transport.timeline

/**
 * In Arabic the page is right to left, and what sits at a side follows it: the composer's Pay and identity sheet opens
 * above its + (at the composer's start), a list's wrapped lines start where its words do, a tag's gap is between it and
 * the name. These kept left-side classes and CSS, so in Arabic the sheet opened at the far end and the lines hugged the
 * left. English keeps its layout. Layout itself is measured in a browser; here, the classes and rules that give it.
 */
const read = (file: string) => readFileSync(join(fileURLToPath(import.meta.url), "../../..", file), "utf8");
const NEW_WALLET = read("components/wallet/new-wallet.css"), INDEX = read("index.css");
/** The declarations of the rule with exactly this selector. */
const rule = (css: string, selector: string) => {
  const at = css.split(/\r?\n/).find(l => l.trimStart().startsWith(`${selector}{`) || l.trimStart().startsWith(`${selector} {`));
  return at?.slice(at.indexOf("{") + 1, at.lastIndexOf("}")) ?? "";
};

describe.each(["ar", "en"] as const)("in %s", (language) => {
  it("the page's direction is the language's", () => {
    renderApp(<p />, { language });
    expect(document.documentElement).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
  });

  it("the composer's Pay and identity sheet opens at the composer's start, where its + is", () => {
    renderApp(<div className="relative"><ComposerSheet data-testid="sheet">…</ComposerSheet></div>, { language });
    expect(screen.getByTestId("sheet")).toHaveClass("start-0");
    expect(screen.getByTestId("sheet")).not.toHaveClass("left-0");
  });

  it("the home screen's features start where their words do", () => {
    renderApp(<Home />, { language });
    const list = screen.getByText(lookup(language, "home.features.encrypted")!).closest("ul");
    expect(list).toHaveClass("text-start");
    expect(list).not.toHaveClass("text-left");
  });

  it("a group's joining steps start where their words do", () => {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [groupView({ canSend: false, invitation: { linkId: "", contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage: "knocked" } })] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language });
    expect(screen.getByTestId("group-joining-steps")).toHaveClass("text-start");
    expect(screen.getByTestId("group-joining-steps")).not.toHaveClass("text-left");
  });

  it("Connection history's title keeps its room at its end", () => {
    renderApp(<ConnectionHistory events={[{ at: 1, kind: "down", from: "webrtc/1" }]} contact="Ana" />, { language });
    const summary = screen.getByTestId("connection-history").querySelector("summary");
    expect(summary).toHaveClass("pe-2");
    expect(summary).not.toHaveClass("pr-2");
  });
});

describe("right to left, the CSS", () => {
  it("Wallets → New: a network's and a kind's text start on the card's start side", () => {
    for (const selector of [".new-wallet-network", ".new-wallet-kind"]) {
      expect([selector, rule(NEW_WALLET, selector)]).toEqual([selector, expect.stringContaining("text-align:start")]);
      expect(rule(NEW_WALLET, selector)).not.toContain("text-align:left");
    }
  });

  it("Wallets → New: a kind's action nudges toward its end on hover, the other way right to left", () => {
    const hover = ".new-wallet-kind:hover:not(:disabled):not([aria-disabled=true]) .new-wallet-action";
    expect(rule(NEW_WALLET, hover)).toContain("transform:translateX(2px)");
    expect(rule(NEW_WALLET, `[dir=rtl] ${hover}`)).toContain("transform:translateX(-2px)");
  });

  it("a payment card's back: the network tag's gap is between it and the name", () => {
    expect(rule(INDEX, ".payment-back-network")).toContain("margin-inline-start:8px");
    expect(rule(INDEX, ".payment-back-network")).not.toContain("margin-left");
  });
});
