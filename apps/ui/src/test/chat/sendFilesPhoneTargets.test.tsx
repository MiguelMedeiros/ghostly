import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { renderApp } from "../render";

// covers: app.composer.paste-files, app.mobile-layout

/**
 * On a phone, Send files (files pasted, dropped or shared into a chat) gives a thumb 44 × 44 px where a tap lands, as
 * the rest of the app does: each file's × was 28 × 28 px and Cancel / Send 40 px tall. The × carry `.tap-target`
 * (index.css), which grows where a tap lands past the box without moving the tile; Cancel and Send are 44 px tall under
 * the phone breakpoint. The measure itself is a browser's (e2e/web/phone-touch-targets.spec.ts).
 */
const INDEX_CSS = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8");

/** A 1 x 1 PNG's header: the sheet draws a picture only once its header says its size. */
const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0];

function pasteFiles(files: File[]) {
  renderApp(<MessageInput onSend={vi.fn().mockResolvedValue(null)} onSendFile={vi.fn().mockResolvedValue(null)} />);
  fireEvent.paste(screen.getByPlaceholderText("Message…"), {
    clipboardData: { files, types: ["Files"], items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })), getData: () => "" },
  });
  return screen.findByTestId("attachment-sheet");
}

const picture = () => new File([new Uint8Array(PNG)], "IMG_0042.png", { type: "image/png" });
const notes = (i: number) => new File([new Uint8Array(100 * i)], `notes-${i}.txt`, { type: "text/plain" });

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:picture");
  URL.revokeObjectURL = vi.fn();
});

describe("Send files on a phone", () => {
  it("a picture and three files: each × is thumb-sized, and its tile does not clip that larger area", async () => {
    const sheet = await pasteFiles([picture(), notes(1), notes(2), notes(3)]);
    await within(sheet).findByRole("img", { name: "IMG_0042.png" });
    const removers = within(sheet).getAllByRole("button", { name: /^Remove / });
    expect(removers.map((button) => button.getAttribute("aria-label"))).toEqual(["Remove IMG_0042.png", "Remove notes-1.txt", "Remove notes-2.txt", "Remove notes-3.txt"]);
    for (const button of removers) {
      expect(button, button.getAttribute("aria-label")!).toHaveClass("tap-target", "absolute");
      const tile = button.closest("li")!;
      expect(tile.className, button.getAttribute("aria-label")!).not.toMatch(/\boverflow-/);
      // The sizes overflow-hidden gave the grid stay: the tiles neither grow with their content nor move.
      expect(tile).toHaveClass("aspect-square", "min-w-0", "min-h-0");
    }
  });

  it("Cancel and Send are 44 px tall, with one file or several", async () => {
    const several = await pasteFiles([picture(), notes(1)]);
    for (const id of ["attachment-cancel", "attachment-send"]) expect(within(several).getByTestId(id), id).toHaveClass("max-md:min-h-11");
    fireEvent.click(within(several).getByTestId("attachment-cancel"));
    expect(screen.queryByTestId("attachment-sheet")).toBeNull();
  });

  it("one file alone: Cancel and Send are 44 px tall too", async () => {
    const one = await pasteFiles([notes(1)]);
    for (const id of ["attachment-cancel", "attachment-send"]) expect(within(one).getByTestId(id), id).toHaveClass("max-md:min-h-11");
  });

  it("a .tap-target placed with absolute stays where it is: the phone rule makes only the others relative", () => {
    const phone = INDEX_CSS.match(/@media \(width < 48rem\) \{\n((?: {2}[^\n]*\n)*?\s*\.tap-target::after[^\n]*\n)\}/)?.[1] ?? "";
    expect(phone).toMatch(/\.tap-target::after \{/);
    expect(phone).toMatch(/\.tap-target:not\(\.absolute\) \{ position: relative; \}/);
    expect(phone).not.toMatch(/\.tap-target \{[^}]*position/);
  });
});
