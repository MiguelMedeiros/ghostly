/** Release policy: external identity experiments are retained for future work,
 * but must not advertise capabilities, start network lookups, or expose cached
 * external profiles. This does not gate Ghostly participation authentication. */
export const EXTERNAL_IDENTITIES_ENABLED: boolean = false;

/** Mini-apps (WISP 1200): `apps/1` on paired sessions and the engine's `app*` calls. On from release 1.2 (a version
 * before 1.2.0 is never cut with it on: `RELEASE_GUARDS` in tools/scripts/changes.mjs). Off, nothing is offered to
 * contacts and every call is refused; a host that runs no apps pins its engine off (`NodeOptions.apps`). */
export const APPS_ENABLED: boolean = true;
