// @vitest-environment happy-dom
// covers: apps.chess
// The board on screen: a chessboard is never mirrored, whatever the language's direction.
import { afterEach, describe, expect, it } from "vitest";
import { ChessController } from "../src/game.ts";
import { en } from "../src/strings.ts";
import { mountChess } from "../src/ui.ts";
import { MockBroker } from "./mockBroker.ts";

afterEach(() => {
  document.documentElement.removeAttribute("dir");
  document.body.replaceChildren();
});

async function mounted(): Promise<HTMLElement> {
  const broker = new MockBroker("ana", "1.0.0", false);
  broker.launch();
  const game = new ChessController(broker);
  await game.start();
  const root = document.createElement("div");
  document.body.append(root);
  mountChess(root, game, en);
  return root;
}

describe("the board", () => {
  it("keeps a1 at white's bottom left in a right-to-left language (Arabic)", async () => {
    // main.ts sets the page's direction from the language, and a grid lays its columns out in that direction: the
    // board came out mirrored, a1 on the right.
    document.documentElement.dir = "rtl";
    const root = await mounted();
    const board = root.querySelector<HTMLElement>(".board")!;
    // The direction an element takes is its nearest `dir`: the board's own, not the page's.
    expect(board.closest("[dir]")?.getAttribute("dir")).toBe("ltr");
    // The first square drawn in the bottom row is a1, and it is a dark square.
    const bottom = board.querySelectorAll(".rank")[7]!.querySelectorAll<HTMLElement>(".sq");
    expect(bottom[0]!.dataset.square).toBe("a1");
    expect(bottom[0]!.classList.contains("dark")).toBe(true);
  });

  it("stays left to right in a left-to-right language", async () => {
    const root = await mounted();
    expect(root.querySelector<HTMLElement>(".board")!.closest("[dir]")?.getAttribute("dir")).toBe("ltr");
  });
});
