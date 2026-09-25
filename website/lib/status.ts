/**
 * How far along something is, for the people using it. "Available" is what the
 * app on `dev` does today (the 0.5.0 release); "planned" and "research" are
 * only for what is not built. "Draft" is a separate axis: every WISP is a
 * Draft, whatever its implementation status.
 */
export const LEVELS = ["available", "planned", "research"] as const;
export type Level = (typeof LEVELS)[number];
