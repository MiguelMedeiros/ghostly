import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { setStorageProfile as setProfile } from "../../lib/storage";
import { AppProviders } from "../render";

// covers: chat.paired.send

const onSend = vi.fn<(text: string) => Promise<string | null>>(async () => null);
const composer = (disabled: boolean) => <LockScreenProvider><MessageInput draftId="focus-test" onSend={onSend} disabled={disabled} /></LockScreenProvider>;
/** A wrapper that stays the same across rerenders (renderApp's is new each time, which would mount a new composer). */
const Providers = ({ children }: { children: ReactNode }) => <AppProviders>{children}</AppProviders>;
const renderApp = (ui: React.ReactElement) => ({ ...render(ui, { wrapper: Providers }), user: userEvent.setup() });
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

/**
 * What Chrome and WebKit do to a focused field that turns disabled: they take its focus away, to the body. happy-dom
 * keeps it (and ignores blur() on a disabled field), so the test lets go of it for them.
 */
const browserDropsFocus = () => act(() => {
  const input = field();
  expect(input).toBeDisabled();
  input.disabled = false; input.blur(); input.disabled = true;
});

afterEach(() => { localStorage.clear(); setProfile(""); });

describe("the composer's caret while a send disables it", () => {
  it("comes back to the field once it is enabled again", async () => {
    const { rerender } = renderApp(composer(false));
    expect(field()).toHaveFocus();
    rerender(composer(true));
    browserDropsFocus();
    expect(field()).not.toHaveFocus();
    rerender(composer(false));
    expect(field()).toHaveFocus();
  });

  it("stays where the person put it meanwhile", async () => {
    const { rerender, user } = renderApp(<>{composer(false)}<button type="button">elsewhere</button></>);
    rerender(<>{composer(true)}<button type="button">elsewhere</button></>);
    browserDropsFocus();
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    rerender(<>{composer(false)}<button type="button">elsewhere</button></>);
    expect(screen.getByRole("button", { name: "elsewhere" })).toHaveFocus();
  });

  it("is not taken when the field did not have it", async () => {
    const { rerender } = renderApp(<>{composer(false)}<button type="button">elsewhere</button></>);
    screen.getByRole("button", { name: "elsewhere" }).focus();
    rerender(<>{composer(true)}<button type="button">elsewhere</button></>);
    act(() => { (document.activeElement as HTMLElement).blur(); });
    rerender(<>{composer(false)}<button type="button">elsewhere</button></>);
    expect(field()).not.toHaveFocus();
  });
});
