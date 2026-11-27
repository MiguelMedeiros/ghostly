import { act } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DeleteChatDialog } from "../../components/DeleteChatDialog";
import { IncomingCallNotification } from "../../components/IncomingCallNotification";
import { renderApp } from "../render";

// covers: calls.audio

/**
 * A call that rings while a <dialog> is open (Delete chat?, Forward, New group): the dialog is modal, so a browser
 * makes everything outside it inert, the ringing card with it: Accept took no click and no focus until the dialog was
 * closed. The dialog makes way as Escape would close it, the card has the focus, and once it stops ringing the focus
 * goes back to what opened the dialog.
 */
function Chat({ ringing, onClose }: { ringing: boolean; onClose?: () => void }) {
  const [asking, setAsking] = useState(false);
  const options = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={options} onClick={() => setAsking(true)}>Options</button>
      {asking && <DeleteChatDialog name="Casper" onClose={() => { onClose?.(); setAsking(false); }} onConfirm={vi.fn()} />}
      {ringing && (
        <IncomingCallNotification peerName="Casper" hasVideo={false}
          onAcceptAudio={vi.fn()} onAcceptVideo={vi.fn()} onReject={vi.fn()} />
      )}
    </>
  );
}

describe("a call that rings over an open dialog", () => {
  it("closes the dialog as Escape would, and the card has the focus", async () => {
    const onClose = vi.fn();
    const view = renderApp(<Chat ringing={false} onClose={onClose} />);
    await view.user.click(view.getByRole("button", { name: "Options" }));
    expect(view.getByRole("button", { name: /cancel/i })).toHaveFocus();
    expect(document.querySelector("dialog[open]")).not.toBeNull();

    await act(async () => view.rerender(<Chat ringing onClose={onClose} />));
    await act(async () => { await new Promise((done) => setTimeout(done)); });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(view.getByRole("alertdialog")).toHaveFocus();
  });

  it("once it stops ringing, gives the focus back to what opened the dialog", async () => {
    const view = renderApp(<Chat ringing={false} />);
    await view.user.click(view.getByRole("button", { name: "Options" }));
    await act(async () => view.rerender(<Chat ringing />));
    await act(async () => { await new Promise((done) => setTimeout(done)); });

    await act(async () => view.rerender(<Chat ringing={false} />));
    expect(view.getByRole("button", { name: "Options" })).toHaveFocus();
  });
});
