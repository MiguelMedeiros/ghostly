/** Release policy: external identity experiments are retained for future work,
 * but must not advertise capabilities, start network lookups, or expose cached
 * external profiles. This does not gate Ghostly participation authentication. */
export const EXTERNAL_IDENTITIES_ENABLED: boolean = false;

/** Mini-apps (WISP 1200): `apps/1` on paired sessions and the engine's `app*` calls. On from release 1.2 (a version
 * before 1.2.0 is never cut with it on: `RELEASE_GUARDS` in tools/scripts/changes.mjs). Off, nothing is offered to
 * contacts and every call is refused; a host that runs no apps pins its engine off (`NodeOptions.apps`). */
export const APPS_ENABLED: boolean = true;

/**
 * A build that may be put into test mode: a development build (`import.meta.env.DEV`, which vitest also sets) or the
 * e2e suite's build (`VITE_APPS_TEST`, fixed when the build is made, as the mini-app switch is). A release build is
 * neither: Vite folds this to `false` there, so the storage flags the test fakes answer to are ignored. The fakes
 * themselves are still in the bundle (the registries import them); plugins may still pass fakes to the registry.
 */
export const testBuild = (): boolean => { try { return !!import.meta.env?.DEV || import.meta.env?.VITE_APPS_TEST === "1"; } catch { return false; } };
