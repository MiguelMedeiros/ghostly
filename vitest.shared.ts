/**
 * Settings every Vitest config here shares.
 *
 * Locally, several sessions test on one machine at once, and Vitest's default (a worker per core) in each of them
 * starved the machine: at most JOBS workers (default 2) when CI is unset. CI keeps Vitest's default.
 * `vitest --maxWorkers=<n>` still wins over this.
 */
export const maxWorkers = process.env.CI ? undefined : Math.max(1, Number(process.env.JOBS) || 2);
