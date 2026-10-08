import type { Translate } from "../contexts/I18nContext";
import { knownErrorParts, rawError } from "./errorText";
import type { Problem } from "./problemText";

/*
 * A link the app could not hand to the system (Desktop's opener, Android's: no app for it, a refused address). A link
 * whose place shows nothing of its own (`externalLinkProps` without `onError`) is said here, once for the whole app,
 * by components/OpenFailureNotice.tsx.
 */

type Listener = (error: unknown) => void;
let listener: Listener | null = null;

/** The app-wide notice listens; returns a stop. */
export function onOpenFailure(next: Listener): () => void {
  listener = next;
  return () => { if (listener === next) listener = null; };
}

/** A link could not be opened, and its place says nothing of it. */
export function reportOpenFailure(error: unknown): void {
  listener?.(error);
}

/** A failed open as a notice: what happened and what to do, in the app's language; the reason behind the ⓘ. */
export function openProblem(cause: unknown, t: Translate): Problem {
  const raw = rawError(cause);
  const known = knownErrorParts(cause, t);
  return {
    tone: "error",
    title: known?.title ?? t("errors.host.openFailed"),
    next: known?.next ?? t("errors.host.openFailedNext"),
    ...(raw && { detail: raw }),
  };
}
