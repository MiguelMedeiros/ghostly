import type { Atom, Detector } from "./types";

/** How long an unbroken key-like run must be before it folds to one line. */
export const BLOB_MIN = 80;

/**
 * A long run with no spaces made of base64, base64url or hex characters: a key, a signature, a token pasted in
 * full. It folds to one line with "Show all" and Copy. Links and money come first (a link's path is never a blob,
 * and a Cashu token or an invoice has its own card).
 */
export const blob: Detector<"blob", null> = {
  kind: "blob",
  pattern: new RegExp(`(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{${BLOB_MIN},}={0,2}(?![A-Za-z0-9+/=_-])`, "g"),
  accept: () => ({ data: null }),
  plain: (atom: Atom<"blob", null>) => `${atom.text.slice(0, 12)}…`,
};
