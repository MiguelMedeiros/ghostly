import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RailAction } from "../../components/ChatRail";
import { renderApp } from "../render";

// covers: app.accessibility, chats.list.rail

/**
 * Forced colors (Windows Contrast themes) replace every background with the page's: the folded chat list's New, drawn
 * by the accent square inside the rail's button alone, read as a loose icon there. That square keeps a ButtonText border
 * in forced colors only, as the open list's New does (layout/firstRunButtonsForcedColors.test.ts); the rail's other
 * actions are not filled and get none. What the browser draws is e2e/web/forced-colors-rail-new.spec.ts.
 */
const EDGE = ["forced-colors:border", "forced-colors:border-[color:ButtonText]"];

describe("the rail's New in forced colors", () => {
  it("keeps an edge on the accent square, and none on the rail's other actions", () => {
    renderApp(<>
      <RailAction testId="new" label="Start a chat" accent onClick={() => {}}>+</RailAction>
      <RailAction testId="saved" label="Saved" onClick={() => {}}>S</RailAction>
      <RailAction testId="tasks" label="Tasks" active onClick={() => {}}>T</RailAction>
    </>);
    const square = screen.getByTestId("new").firstElementChild!.className.split(/\s+/);
    for (const name of EDGE) expect(square).toContain(name);
    expect(screen.getByTestId("new").className).not.toContain("forced-colors:border");
    for (const id of ["saved", "tasks"]) expect(screen.getByTestId(id).firstElementChild!.className).not.toContain("forced-colors:border");
  });
});
