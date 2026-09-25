import { useRef, useState } from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuItem, MenuSeparator } from "../../components/Menu";
import { GroupChat } from "../../pages/GroupChat";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.menus

/** How wide the window is, as matchMedia and layout read it. */
const viewport = (width: number, height = 800) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });

function Harness({ onPick = () => {}, portal, align }: { onPick?: () => void; portal?: boolean; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  return <div ref={anchor} data-testid="anchor" className="relative">
    <button onClick={() => setOpen(o => !o)}>Options</button>
    <Menu testId="menu" open={open} onClose={() => setOpen(false)} anchorRef={anchor} portal={portal} align={align}>
      <MenuItem testId="short" onClick={() => { onPick(); setOpen(false); }}>Refresh</MenuItem>
      <MenuSeparator />
      <MenuItem testId="long" hint="Uma pessoa, com um convite" onClick={() => setOpen(false)}>Informações técnicas</MenuItem>
    </Menu>
  </div>;
}

afterEach(() => { viewport(1024, 768); vi.restoreAllMocks(); });

describe("Menu: one line per row", () => {
  it("drops from its opener as wide as its longest row, and no row wraps", async () => {
    const { user } = renderApp(<Harness />);
    await user.click(screen.getByRole("button", { name: "Options" }));
    const menu = screen.getByTestId("menu");
    expect(menu).toHaveAttribute("data-menu", "popover");
    expect(screen.getByTestId("anchor")).toContainElement(menu);
    // Sized by its content, between a floor and the window; the fixed widths that made rows wrap are gone.
    expect(menu.className).toMatch(/\bw-max\b/);
    expect(menu.className).toMatch(/max-w-\[min\(20rem,calc\(100vw-1rem\)\)\]/);
    for (const row of within(menu).getAllByRole("button")) expect(row.className).toMatch(/\bwhitespace-nowrap\b/);
    // Both lines of a row with a hint are one line each, cut rather than wrapped.
    for (const text of menu.querySelectorAll("[data-menu-text]")) expect(text.className).toMatch(/\btruncate\b/);
  });

  it("shows the whole text on hover only when a row had to cut it", async () => {
    const { user } = renderApp(<Harness />);
    await user.click(screen.getByRole("button", { name: "Options" }));
    const [short, long] = [screen.getByTestId("short"), screen.getByTestId("long")];
    const label = long.querySelector<HTMLElement>("[data-menu-text]")!;
    Object.defineProperty(label, "scrollWidth", { configurable: true, value: 400 });
    Object.defineProperty(label, "clientWidth", { configurable: true, value: 300 });
    fireEvent.pointerEnter(short);
    fireEvent.pointerEnter(long);
    expect(short).not.toHaveAttribute("title");
    expect(long).toHaveAttribute("title", expect.stringContaining("Informações técnicas"));
  });

  it("moves over to stay inside the window, and opens upward when there is no room below", async () => {
    viewport(800, 300);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // The opener sits low at the right edge; the menu, uncorrected, would run 60px past the window's right edge.
      const box = this.dataset.testid === "menu" ? { left: 660, right: 852, top: 280, bottom: 480 } : this.dataset.testid === "anchor" ? { left: 760, right: 792, top: 240, bottom: 276 } : { left: 0, right: 0, top: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    const { user } = renderApp(<Harness />);
    await user.click(screen.getByRole("button", { name: "Options" }));
    const menu = screen.getByTestId("menu");
    expect(menu.style.translate).toBe(`${800 - 8 - 852}px 0`);
    expect(menu.className).toMatch(/\bbottom-full\b/);
  });

  it("portal: drawn over the page by its opener, kept in the window, and following it when the list scrolls", async () => {
    viewport(800, 300);
    let opener = { left: 760, right: 792, top: 240, bottom: 276 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      // A 192 × 200 menu; its opener low at the window's right edge, as a row's button in the chat list is.
      const box = this.dataset.testid === "menu" ? { left: 0, right: 192, top: 0, bottom: 200 } : this.dataset.testid === "anchor" ? opener : { left: 0, right: 0, top: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    const pick = vi.fn();
    const { user } = renderApp(<Harness portal onPick={pick} />);
    await user.click(screen.getByRole("button", { name: "Options" }));
    const menu = screen.getByTestId("menu");
    expect(menu).toHaveAttribute("data-menu", "popover");
    expect(screen.getByTestId("anchor")).not.toContainElement(menu);
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toMatch(/\bfixed\b/);
    // Its end on the opener's end; no room below, so above it (the gap is mt-1's 4px).
    expect(menu.style.left).toBe(`${792 - 192}px`);
    expect(menu.style.top).toBe(`${240 - 4 - 200}px`);

    // The list scrolls: the menu goes with its opener, now with room below.
    opener = { left: 760, right: 792, top: 40, bottom: 76 };
    act(() => { window.dispatchEvent(new Event("scroll")); });
    expect(menu.style.top).toBe(`${76 + 4}px`);
    // A click in it is not a click outside it.
    await user.click(screen.getByTestId("short"));
    expect(pick).toHaveBeenCalledOnce();
  });

  it("portal: lined up with the opener's start, it moves over to stay inside the window", async () => {
    viewport(800, 600);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const box = this.dataset.testid === "menu" ? { left: 0, right: 192, top: 0, bottom: 200 } : this.dataset.testid === "anchor" ? { left: 700, right: 732, top: 40, bottom: 76 } : { left: 0, right: 0, top: 0, bottom: 0 };
      return { ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top, toJSON: () => box } as DOMRect;
    });
    const { user } = renderApp(<Harness portal align="start" />);
    await user.click(screen.getByRole("button", { name: "Options" }));
    expect(screen.getByTestId("menu").style.left).toBe(`${800 - 8 - 192}px`);
    expect(screen.getByTestId("menu").style.top).toBe(`${76 + 4}px`);
  });

  it("is a sheet from the bottom on a phone, with full-width rows; the backdrop closes it", async () => {
    viewport(390, 844);
    const pick = vi.fn();
    const { user } = renderApp(<Harness onPick={pick} />);
    await user.click(screen.getByRole("button", { name: "Options" }));
    const sheet = screen.getByTestId("menu");
    expect(sheet).toHaveAttribute("data-menu", "sheet");
    expect(screen.getByTestId("anchor")).not.toContainElement(sheet);
    expect(sheet.className).toMatch(/\binset-x-0\b/);
    for (const row of within(sheet).getAllByRole("button")) expect(row.className).toMatch(/\bw-full\b/);
    await user.click(screen.getByTestId("short"));
    expect(pick).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Options" }));
    const backdrop = screen.getByTestId("menu-backdrop");
    act(() => { backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); });
    expect(screen.queryByTestId("menu")).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const { user } = renderApp(<Harness />);
    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("menu")).not.toBeInTheDocument();
  });
});

describe("Menu: the group's options speak the app's language", () => {
  it("in Portuguese", async () => {
    fakeEngine.on("groupMessages", () => []).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, isAdmin: true })] });
    const { user } = renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1", language: "pt" });
    await user.click(screen.getByTitle("Opções"));
    const menu = screen.getByTestId("group-options-menu");
    expect(within(menu).getAllByRole("button").map(b => b.textContent)).toEqual(["Membros…", "Silenciar notificações…", "Renovar chaves", "Sair do grupo", "Apagar deste dispositivo"]);
  });
});
