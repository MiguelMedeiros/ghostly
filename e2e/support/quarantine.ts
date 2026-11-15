import type { PlaywrightTestConfig } from "@playwright/test";

const QUARANTINE = /@quarantine\b/;

/**
 * The config without the tests tagged @quarantine: flaky, out of the gate for at most 7 days with their issue
 * (docs/TESTING.md, "Quarantine"; tools/scripts/quarantine.mjs checks the dates). Added to the config's grepInvert and to
 * each project's own, which replaces it. The nightly E2E (full) sets GHOSTLY_QUARANTINE=1 and runs them.
 */
export function withoutQuarantine<T extends PlaywrightTestConfig>(config: T): T {
  if (process.env.GHOSTLY_QUARANTINE === "1") return config;
  const add = (grepInvert: RegExp | RegExp[] | undefined) => [...(grepInvert ? [grepInvert].flat() : []), QUARANTINE];
  return {
    ...config,
    grepInvert: add(config.grepInvert),
    projects: config.projects?.map((project) => (project.grepInvert ? { ...project, grepInvert: add(project.grepInvert) } : project)),
  };
}
