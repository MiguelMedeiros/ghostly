import { useEffect, useRef, useState } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncomingCallNotification } from "../../components/IncomingCallNotification";
import { Menu, MenuItem } from "../../components/Menu";
import { useDialogFocus, useTabTrap } from "../../hooks/useDismiss";
import { renderApp } from "../render";

// covers: calls.audio, app.menus

/** A chat's ⋮ with its menu, opened from the keyboard (the first row takes the focus). */
function ChatMenu() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  return <div ref={anchor} className="relative">
    <button onClick={() => setOpen(o => !o)}>Chat options</button>
    <Menu testId="menu" open={open} onClose={() => setOpen(false)} anchorRef={anchor} focusFirst>
      <MenuItem testId="row" onClick={() => setOpen(false)}>Mute</MenuItem>
    </Menu>
  </div>;
}

const ring = () => <IncomingCallNotification peerName="Casper" hasVideo={false} onAcceptAudio={vi.fn()} onAcceptVideo={vi.fn()} onReject={vi.fn()} />;

describe("a layer opened over an open menu", () => {
  it("a ringing card: Escape and a tap in it leave the menu under it open, and the focus goes back to its row after", async () => {
    // Escape in the card closed the menu under it; Decline then found its return target (the menu's row) gone, and the
    // focus fell to the page.
    const page = renderApp(<ChatMenu />);
    await page.user.click(screen.getByRole("button", { name: "Chat options" }));
    const row = screen.getByTestId("row");
    expect(row).toHaveFocus();
    const call = renderApp(ring());
    const card = call.getByRole("alertdialog");
    expect(card).toHaveFocus();
    await page.user.keyboard("{Escape}");
    expect(screen.getByTestId("menu")).toBeInTheDocument();
    fireEvent.pointerDown(card);
    fireEvent.pointerUp(card);
    expect(screen.getByTestId("menu")).toBeInTheDocument();
    await act(async () => call.unmount());
    expect(row).toHaveFocus();
    // The card gone, the menu answers Escape again.
    await page.user.keyboard("{Escape}");
    expect(screen.queryByTestId("menu")).not.toBeInTheDocument();
  });

  it("a modal of plain elements: Escape closes it alone", async () => {
    const onClose = vi.fn();
    function Modal() {
      const ref = useRef<HTMLDivElement>(null);
      useDialogFocus(ref, onClose);
      return <div ref={ref} role="dialog" aria-modal="true" aria-label="Details" tabIndex={-1}><button>OK</button></div>;
    }
    const page = renderApp(<ChatMenu />);
    await page.user.click(screen.getByRole("button", { name: "Chat options" }));
    renderApp(<Modal />);
    await page.user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("menu")).toBeInTheDocument();
  });

  it("a window that holds the menu, made modal again while it is open (a call out of its small window): the menu still closes on Escape", async () => {
    const call: { grow?: () => void } = {};
    function Call() {
      const ref = useRef<HTMLDivElement>(null);
      const [mini, setMini] = useState(true);
      useEffect(() => { call.grow = () => setMini(false); }, []);
      useTabTrap(ref, !mini);
      return <div ref={ref} role="dialog" aria-modal={!mini} aria-label="Call"><ChatMenu /></div>;
    }
    const { user } = renderApp(<Call />);
    await user.click(screen.getByRole("button", { name: "Chat options" }));
    act(() => call.grow!());
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("menu")).not.toBeInTheDocument();
  });
});
