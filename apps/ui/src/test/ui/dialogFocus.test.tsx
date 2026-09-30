import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { useDialogFocus } from "../../hooks/useDismiss";

// covers: app.menus

/**
 * The modals made of plain elements (New wallet, Add an identity, the chat's hold and services dialogs, the camera, the
 * attachment sheet…) keep Tab inside them: it used to walk out to the chat list and the page behind the backdrop.
 */
function Modal({ name, onClose, children }: { name: string; onClose: () => void; children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  return (
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={name}>
      <button type="button">{name} first</button>
      <button type="button" disabled>{name} off</button>
      <input aria-label={`${name} field`} />
      <button type="button">{name} last</button>
      {children}
    </div>
  );
}

function Page() {
  const [open, setOpen] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <button type="button">Behind</button>
      {open && <Modal name="Outer" onClose={() => setOpen(false)}>
        <button type="button" onClick={() => setInner(true)}>Open inner</button>
      </Modal>}
      {inner && <Modal name="Inner" onClose={() => setInner(false)} />}
    </>
  );
}

describe("a modal made of plain elements", () => {
  it("keeps Tab and Shift+Tab going round its own controls, skipping disabled ones", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog", { name: "Outer" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Outer first" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Outer field" })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Open inner" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Outer first" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Open inner" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Behind" })).not.toHaveFocus();
  });

  it("the newest of two keeps Tab, and Escape closes it first, then the one under it", async () => {
    const user = userEvent.setup();
    render(<Page />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Open inner" }));
    expect(screen.getByRole("dialog", { name: "Inner" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Inner last" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Inner first" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Inner" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeInTheDocument();
  });
});
