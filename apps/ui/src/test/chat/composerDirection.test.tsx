import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { renderApp } from "../render";

// covers: app.i18n

/**
 * The message field reads a draft in its own direction, as its bubble will: from its first letter (`dir="auto"`). Empty or
 * with no letter yet it keeps the app's, so the placeholder and a lone emoji stay where the app writes. The direction a
 * browser draws: e2e/web/text-direction.spec.ts.
 */
describe("the message field's direction", () => {
  const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
  const type = (text: string) => fireEvent.change(field(), { target: { value: text } });

  it("follows the draft's first letter, and the app's while there is none", () => {
    renderApp(<LockScreenProvider><MessageInput onSend={vi.fn(async () => null)} /></LockScreenProvider>);
    expect(field()).not.toHaveAttribute("dir");
    type("👍 2");
    expect(field()).not.toHaveAttribute("dir");
    type("draft kept?");
    expect(field()).toHaveAttribute("dir", "auto");
    type("مرحبا يا صديقي!");
    expect(field()).toHaveAttribute("dir", "auto");
    type("");
    expect(field()).not.toHaveAttribute("dir");
  });
});
