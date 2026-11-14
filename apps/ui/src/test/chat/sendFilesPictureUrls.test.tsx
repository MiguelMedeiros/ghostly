import { act, fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentSheet } from "../../components/composer/AttachmentSheet";
import { renderApp } from "../render";

// covers: app.composer.paste-files

/**
 * Send files makes one object URL per picture for as long as it stays on the sheet: once its header read says yes, and
 * revoked when it leaves (× or close). Each header read answers on its own, as file reads do; every answer remade the URL
 * of each picture already known, so the browser decoded the first one again for each later one (n(n+1)/2 decodes).
 */
const answers = new Map<File, (yes: boolean) => void>();
vi.mock("../../lib/decodablePicture", () => ({
  decodablePicture: (file: File) => new Promise<boolean>((resolve) => answers.set(file, resolve)),
}));

let made: string[];
let revoked: string[];
beforeEach(() => {
  answers.clear();
  made = [];
  revoked = [];
  URL.createObjectURL = vi.fn(() => { const url = `blob:picture-${made.length}`; made.push(url); return url; });
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
});

const pictures = (n: number) => Array.from({ length: n }, (_, i) => new File([new Uint8Array(8)], `IMG_${i}.png`, { type: "image/png" }));

function Sheet({ start, open }: { start: File[]; open: boolean }) {
  const [files, setFiles] = useState(start);
  return open ? <AttachmentSheet files={files} onPaste={() => false} onRemove={(i) => setFiles((was) => was.filter((_, j) => j !== i))} onSend={vi.fn()} onCancel={vi.fn()} /> : null;
}

/** The sheet with `n` pictures, each header read answering yes on its own, one after the other. `changes`: each time a
 * drawn tile's `src` changed (the browser fetches and decodes that picture again), by the tile's name. */
async function openAnswered(n: number) {
  const files = pictures(n);
  const view = renderApp(<Sheet start={files} open />);
  // Each `<img>` and every `src` it was given (a change: one more than the first).
  const sources = new Map<HTMLImageElement, Set<string>>();
  const observer = new MutationObserver((records) => {
    for (const { target } of records) {
      if (!(target instanceof HTMLImageElement)) continue;
      sources.set(target, (sources.get(target) ?? new Set()).add(target.getAttribute("src")!));
    }
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["src"] });
  for (const file of files) await act(async () => answers.get(file)!(true));
  await act(async () => {});
  observer.disconnect();
  const changes = [...sources].flatMap(([img, srcs]) => Array<string>(srcs.size - 1).fill(img.alt));
  const sheet = screen.getByTestId("attachment-sheet");
  expect(within(sheet).getAllByRole("img")).toHaveLength(n);
  return { files, view, sheet, changes };
}

describe("Send files: one object URL per picture", () => {
  it("50 pictures whose header reads answer one at a time: 50 URLs, and no tile's src changes once drawn", async () => {
    const { changes } = await openAnswered(50);
    expect.soft(made).toHaveLength(50);
    expect.soft(revoked).toHaveLength(0);
    expect.soft(changes).toHaveLength(0);
  });

  it("taking one out revokes its URL only: every other picture keeps the URL it had", async () => {
    const { sheet } = await openAnswered(50);
    const before = new Map(within(sheet).getAllByRole("img").map((img) => [img.getAttribute("alt"), img.getAttribute("src")]));
    const [count, gone] = [made.length, revoked.length];
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove IMG_2.png" }));
    await act(async () => {});
    expect(made.length - count).toBe(0);
    expect(revoked.slice(gone)).toEqual([before.get("IMG_2.png")]);
    // The tiles are kept by place: the ones after it move up, each with its own picture's URL.
    const after = within(sheet).getAllByRole("img");
    expect(after).toHaveLength(49);
    for (const img of after) expect(img.getAttribute("src"), img.getAttribute("alt")!).toBe(before.get(img.getAttribute("alt")));
  });

  it("closing the sheet leaves no URL behind", async () => {
    const { files, view } = await openAnswered(10);
    view.rerender(<Sheet start={files} open={false} />);
    expect(made.length).toBeGreaterThan(0);
    expect(new Set(revoked)).toEqual(new Set(made));
    expect(revoked).toHaveLength(made.length);
  });
});
