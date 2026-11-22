import "fake-indexeddb/auto";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { fakeEngine } from "../fakeEngine";
import { everythingOnScreen } from "../onScreen";
import { renderApp } from "../render";

// covers: app.accessibility, app.theme

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/*
 * The chat list's search is framed by its fill and an inset ring (a box-shadow): forced colors (Windows Contrast) drop
 * both, which left the magnifier and the placeholder as a loose line. In forced colors only, the frame gets a border
 * in the theme's text colour, its padding 1px less so it keeps its size. What the browser draws is
 * e2e/web/forced-colors-controls.spec.ts.
 */

beforeEach(() => everythingOnScreen());

describe("the chat list's search in forced colors", () => {
  it("has a CanvasText border there and none in normal colours, at the same size", () => {
    fakeEngine.update({ groups: [], groupsLoaded: true });
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const frame = screen.getByRole("searchbox", { name: "Search chats" }).parentElement!;
    const classes = frame.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["forced-colors:border", "forced-colors:border-[color:CanvasText]", "forced-colors:px-[11px]", "forced-colors:py-[5px]"]));
    expect(classes).toEqual(expect.arrayContaining(["px-3", "py-1.5"]));
    expect(classes.filter(c => /^border(-|$)/.test(c))).toEqual([]);
  });
});
