import { createRef } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AttachmentSheet } from "../../components/composer/AttachmentSheet";
import { ExpressionPanel } from "../../components/composer/ExpressionPanel";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { renderApp } from "../render";

/**
 * Escape typed into a field to drop an input method's candidate (Japanese, Chinese, Korean…) is the input method's:
 * the sheet or panel the field is in stays, with what was picked and typed there. Chromium sends that Escape while
 * composing; WebKit right after the composition ended, as 229. A plain Escape still closes it.
 */
describe("an input method's Escape leaves the layer it was typed in open", () => {
  it("Send files: the caption's candidate dropped keeps the sheet and its files", () => {
    const onCancel = vi.fn();
    renderApp(<AttachmentSheet files={[new File(["hi"], "notes.txt", { type: "text/plain" })]} onPaste={() => false} onRemove={() => {}} onSend={() => {}} onCancel={onCancel} />, { language: "ja" });
    const caption = screen.getByTestId("attachment-caption");
    fireEvent.compositionStart(caption);
    fireEvent.keyDown(caption, { key: "Escape", isComposing: true });
    fireEvent.compositionEnd(caption, { data: "" });
    fireEvent.keyDown(caption, { key: "Escape", keyCode: 229 });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(caption, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Emoji: the search's candidate dropped keeps the panel", async () => {
    const onClose = vi.fn();
    const bounds = createRef<HTMLDivElement>(), dismiss = createRef<HTMLDivElement>();
    renderApp(<LockScreenProvider><div ref={bounds} /><div ref={dismiss} /><ExpressionPanel boundsRef={bounds} dismissRef={dismiss} onEmoji={() => {}} onGif={() => {}} onClose={onClose} focusOnOpen /></LockScreenProvider>, { language: "ja" });
    const search = await screen.findByTestId("expression-search");
    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: "Escape", isComposing: true });
    fireEvent.compositionEnd(search, { data: "" });
    fireEvent.keyDown(search, { key: "Escape", keyCode: 229 });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
