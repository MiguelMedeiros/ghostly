/**
 * The Chess the end-to-end tests run: one pinned, self-contained HTML file in e2e/fixtures/chess (index.html.txt: .txt
 * so code scanning leaves the code it inlines alone), with chess.json saying where it came from.
 * `node tools/scripts/refresh-chess-fixture.mjs` writes both (from apps/mini/chess, or from a signed Chess bundle), and
 * tools/scripts/test/chessFixture.test.ts checks them; no spec builds Chess itself.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CHESS_FIXTURE_DIR = resolve(import.meta.dirname, "../fixtures/chess");

/** The path of Chess's one HTML file. */
export const CHESS_ENTRY = resolve(CHESS_FIXTURE_DIR, "index.html.txt");

/** Chess's one HTML file, as text. */
export const chessEntryHtml = (): string => readFileSync(CHESS_ENTRY, "utf8");
