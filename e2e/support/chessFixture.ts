/**
 * The Chess the end-to-end tests run: one pinned, self-contained HTML file in e2e/fixtures/chess (index.html.txt: .txt
 * so code scanning leaves the code it inlines alone), the manifest it is published with (ghostly-app.json), and
 * chess.json saying where they came from. `node tools/scripts/refresh-chess-fixture.mjs --bundle <url>` writes them from
 * the bundle Chess's publisher signed in Chess's own repository, and tools/scripts/test/chessFixture.test.ts checks
 * them; no spec builds Chess itself. e2e/fixtures/chess/1.0.2 is the last Chess built in this repository (it asks for
 * `chat` alone), kept for the update test.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CHESS_FIXTURE_DIR = resolve(import.meta.dirname, "../fixtures/chess");

/** The path of Chess's one HTML file. */
export const CHESS_ENTRY = resolve(CHESS_FIXTURE_DIR, "index.html.txt");

/** Chess's one HTML file, as text. */
export const chessEntryHtml = (): string => readFileSync(CHESS_ENTRY, "utf8");

/** One pinned Chess: the path of its page, and the manifest it is published with. */
export interface ChessBuild { entry: string; manifest: Record<string, unknown> & { version: string; permissions: string[] } }

const build = (dir: string): ChessBuild => ({
  entry: resolve(dir, "index.html.txt"),
  manifest: JSON.parse(readFileSync(resolve(dir, "ghostly-app.json"), "utf8")) as ChessBuild["manifest"],
});

/** The Chess of today (2.3.0: `chat` and `name`). */
export const CHESS = build(CHESS_FIXTURE_DIR);

/** Chess 1.0.2 (`chat` alone), what a person may still have installed. */
export const CHESS_1_0_2 = build(resolve(CHESS_FIXTURE_DIR, "1.0.2"));
