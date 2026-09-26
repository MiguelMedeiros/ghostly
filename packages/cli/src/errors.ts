/**
 * Errors that reach a bot: a stable `code` to branch on, a message for people, and the exit status the CLI
 * leaves with (WISP 11xx § Exit codes). The daemon sends `{code, message}` over the socket; the CLI prints
 * `{"error": {code, message}}` on stdout and exits with `exit`.
 */
export type ErrorCode =
  | "bad_request" | "usage" | "not_found" | "refused" | "unavailable" | "confirm" | "timeout"
  | "engine" | "busy" | "internal";

export const EXIT: Record<ErrorCode, number> = {
  engine: 1, refused: 1, unavailable: 1, bad_request: 1, busy: 1, internal: 1,
  usage: 2, not_found: 3, timeout: 4, confirm: 5,
};

export class CliError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "CliError";
  }
  toJSON(): { code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

/** Anything thrown, as the error a bot sees: the engine's own refusals keep their words. */
export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error && typeof error === "object" && "code" in error && "message" in error && typeof (error as { code: unknown }).code === "string"
    && (error as { code: string }).code in EXIT) return new CliError((error as { code: ErrorCode }).code, String((error as { message: unknown }).message));
  const message = error instanceof Error ? error.message : String(error);
  if (/real money|confirmedReal|Mainnet/i.test(message) && /confirm/i.test(message)) return new CliError("confirm", message);
  if (/other network|cross-network|network does not match/i.test(message)) return new CliError("refused", message);
  return new CliError("engine", message);
}
