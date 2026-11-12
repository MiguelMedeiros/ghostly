import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RailAction } from "../../components/ChatRail";
import { PageAction } from "../../components/layout/PageAction";
import { QRCodeDisplay } from "../../components/QRCode";
import { renderApp } from "../render";

// covers: app.accessibility, invite.copy

/**
 * Forced colors (Windows Contrast themes) replace every background with the page's: a button drawn by its accent fill
 * alone reads as a loose word there. The first steps' main buttons keep a border in forced colors only. The chat
 * list's New and ▾ and what the browser draws are e2e/web/forced-colors-first-run.spec.ts.
 */
const EDGE = ["forced-colors:border", "forced-colors:border-[color:ButtonText]"];
const keepsAnEdge = (el: Element) => { for (const c of EDGE) expect(el.className.split(/\s+/)).toContain(c); };

describe("the first steps' main buttons in forced colors", () => {
  it("keeps an edge on the invite card's Copy invite", () => {
    renderApp(<QRCodeDisplay value="https://ghostly.tools/#invite" />);
    keepsAnEdge(screen.getByRole("button", { name: "Copy invite" }));
  });

  it("keeps an edge on a page's New", () => {
    renderApp(<PageAction label="New" testId="wallet-add" />);
    keepsAnEdge(screen.getByTestId("wallet-add"));
  });

  it("keeps an edge on the rail's accent New, and none on its other actions", () => {
    renderApp(<><RailAction testId="new" label="Start a chat" accent onClick={() => {}}>+</RailAction><RailAction testId="saved" label="Saved" onClick={() => {}}>S</RailAction></>);
    keepsAnEdge(screen.getByTestId("new").firstElementChild!);
    expect(screen.getByTestId("saved").firstElementChild!.className).not.toContain("forced-colors:border");
  });
});
