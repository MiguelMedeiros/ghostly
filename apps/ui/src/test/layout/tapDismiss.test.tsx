import { useEffect, useRef, useState } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuItem } from "../../components/Menu";
import { useBackdropDismiss } from "../../hooks/useDismiss";
import { renderApp } from "../render";

// covers: app.menus, app.mobile-layout

/** How wide the window is, as matchMedia and layout read it. */
const viewport = (width: number, height = 800) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });

/** A press and a release at one spot: a finger's tap, a pen's, or a mouse's. */
function press(target: Element, pointerType: "touch" | "pen" | "mouse", at = { clientX: 5, clientY: 5 }) {
  const init = { bubbles: true, pointerType, ...at };
  act(() => { target.dispatchEvent(new PointerEvent("pointerdown", init)); target.dispatchEvent(new PointerEvent("pointerup", init)); });
}

/** The mouse events and click a screen sends after the pointer's, where the tap was: here, on `target`. */
function trailing(target: HTMLElement) {
  act(() => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    target.click();
  });
}

/** Something that was under the surface, and counts what reaches it. */
function Behind({ onPress }: { onPress: () => void }) {
  return <button data-testid="behind" onClick={onPress}>Behind</button>;
}

function DialogHarness({ onPress }: { onPress: () => void }) {
  const [open, setOpen] = useState(true);
  return <>
    <Behind onPress={onPress} />
    {open && <Modal onClose={() => setOpen(false)} />}
  </>;
}

function Modal({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdrop = useBackdropDismiss(onClose);
  useEffect(() => { const element = ref.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={ref} data-testid="dialog" {...backdrop}><p>A question</p></dialog>;
}

function MenuHarness({ onPress }: { onPress: () => void }) {
  const [open, setOpen] = useState(true);
  const anchor = useRef<HTMLDivElement>(null);
  return <>
    <Behind onPress={onPress} />
    <div ref={anchor} className="relative">
      <button onClick={() => setOpen(o => !o)}>Options</button>
      <Menu testId="menu" open={open} onClose={() => setOpen(false)} anchorRef={anchor}>
        <MenuItem onClick={() => setOpen(false)}>Refresh</MenuItem>
      </Menu>
    </div>
  </>;
}

afterEach(() => { viewport(1024, 768); vi.useRealTimers(); });

describe("a tap that closes a dialog on its dimmed area", () => {
  it("does not also press what was under it; the next tap does", () => {
    viewport(390, 844);
    const pressed = vi.fn();
    renderApp(<DialogHarness onPress={pressed} />);
    // Outside the dialog's box (happy-dom lays nothing out: its box is at 0,0 with no size).
    press(screen.getByTestId("dialog"), "touch", { clientX: 200, clientY: 800 });
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
    const behind = screen.getByTestId("behind");
    trailing(behind);
    expect(pressed).not.toHaveBeenCalled();
    // The person's own next tap.
    trailing(behind);
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it("drops a pen's trailing click too", () => {
    const pressed = vi.fn();
    renderApp(<DialogHarness onPress={pressed} />);
    press(screen.getByTestId("dialog"), "pen", { clientX: 200, clientY: 800 });
    trailing(screen.getByTestId("behind"));
    expect(pressed).not.toHaveBeenCalled();
  });

  it("with a mouse, the next click is left alone", () => {
    const pressed = vi.fn();
    renderApp(<DialogHarness onPress={pressed} />);
    press(screen.getByTestId("dialog"), "mouse", { clientX: 200, clientY: 800 });
    expect(screen.queryByTestId("dialog")).not.toBeInTheDocument();
    trailing(screen.getByTestId("behind"));
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it("a click that never came is not waited for: one past half a second is the person's", () => {
    vi.useFakeTimers();
    const pressed = vi.fn();
    renderApp(<DialogHarness onPress={pressed} />);
    press(screen.getByTestId("dialog"), "touch", { clientX: 200, clientY: 800 });
    act(() => { vi.advanceTimersByTime(600); });
    trailing(screen.getByTestId("behind"));
    expect(pressed).toHaveBeenCalledTimes(1);
  });
});

describe("a tap that closes a menu", () => {
  it("on a phone, a tap on the sheet's backdrop only closes it", () => {
    viewport(390, 844);
    const pressed = vi.fn();
    renderApp(<MenuHarness onPress={pressed} />);
    expect(screen.getByTestId("menu")).toHaveAttribute("data-menu", "sheet");
    press(screen.getByTestId("menu-backdrop"), "touch");
    expect(screen.queryByTestId("menu")).not.toBeInTheDocument();
    const behind = screen.getByTestId("behind");
    trailing(behind);
    expect(pressed).not.toHaveBeenCalled();
    trailing(behind);
    expect(pressed).toHaveBeenCalledTimes(1);
  });

  it("a tap outside a popover straight onto a button closes it and presses the button, as a mouse does", () => {
    const pressed = vi.fn();
    renderApp(<MenuHarness onPress={pressed} />);
    expect(screen.getByTestId("menu")).toHaveAttribute("data-menu", "popover");
    const behind = screen.getByTestId("behind");
    press(behind, "touch");
    expect(screen.queryByTestId("menu")).not.toBeInTheDocument();
    trailing(behind);
    expect(pressed).toHaveBeenCalledTimes(1);
  });
});
