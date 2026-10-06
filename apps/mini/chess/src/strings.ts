/**
 * The app's words. English is built in; another of the app's 8 languages (en, pt, es, fr, it, ja, zh, ar) is a table
 * passed to addStrings, and pickLanguage chooses from the client's locale (context.locale, else the browser's).
 * A key a table leaves out falls back to English.
 */
export const en = {
  title: "Chess",
  board: "Chessboard",
  loading: "Loading…",
  alone: "Playing both sides. Open Chess in a chat to play your contact.",
  waitingPeer: "Waiting for your contact to open Chess",
  tossing: "Tossing for colours…",
  yourMove: "Your move",
  theirMove: "Their move",
  whiteToMove: "White to move",
  blackToMove: "Black to move",
  youAreWhite: "You play white",
  youAreBlack: "You play black",
  check: "Check",
  away: "Your contact closed Chess. The game waits here.",
  outOfStep: "Your games differ. Start a new one?",
  won: "You win",
  lost: "You lose",
  whiteWins: "White wins",
  blackWins: "Black wins",
  drawn: "Draw",
  why_checkmate: "checkmate",
  why_stalemate: "stalemate",
  why_repetition: "threefold repetition",
  why_fifty: "50-move rule",
  why_material: "not enough material",
  why_limit: "move limit",
  why_resign: "resignation",
  why_agreed: "agreed",
  peerOffersDraw: "Your contact offers a draw",
  youOfferedDraw: "Draw offered",
  offerDraw: "Offer draw",
  accept: "Accept",
  decline: "Decline",
  resign: "Resign",
  resignSure: "Resign? Press again",
  newGame: "New game",
  promoteTo: "Promote to",
  notice_invalidMove: "Ignored an invalid move from your contact.",
  notice_badMessage: "Ignored a message Chess could not read.",
  notice_tooBig: "Ignored a message that was too big.",
  notice_newerVersion: "Your contact has a newer Chess. Update to keep playing.",
  notice_badReveal: "The colour toss failed. Trying again.",
  notice_tossRestarted: "Your contact restarted the colour toss.",
  notice_outOfStep: "Your games differ.",
  notice_peerNewGame: "Your contact started a new game.",
  notice_sendFailed: "Not sent. It goes when your contact is back.",
  white: "white",
  black: "black",
  empty: "empty",
  selected: "selected",
  canMoveHere: "move here",
  lastMove: "last move",
  piece_k: "king",
  piece_q: "queen",
  piece_r: "rook",
  piece_b: "bishop",
  piece_n: "knight",
  piece_p: "pawn",
};

export type Strings = typeof en;
export type StringKey = keyof Strings;

export const LANGUAGES = ["en", "pt", "es", "fr", "it", "ja", "zh", "ar"] as const;
export type Language = (typeof LANGUAGES)[number];

const tables: Partial<Record<Language, Partial<Strings>>> = { en };

/** Adds (or replaces) the words of one language. */
export function addStrings(language: Language, table: Partial<Strings>): void {
  tables[language] = { ...tables[language], ...table };
}

/** The app language for a BCP 47 locale ("pt-BR" is "pt"); English when the app does not have it. */
export function pickLanguage(locale: string | undefined): Language {
  const base = (locale ?? "").toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES as readonly string[]).includes(base) ? (base as Language) : "en";
}

/** The words for a language, English filling any gap. */
export function stringsFor(language: Language): Strings {
  return { ...en, ...tables[language] };
}
