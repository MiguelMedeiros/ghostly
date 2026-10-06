/** Release policy: external identity experiments are retained for future work,
 * but must not advertise capabilities, start network lookups, or expose cached
 * external profiles. This does not gate Ghostly participation authentication. */
export const EXTERNAL_IDENTITIES_ENABLED: boolean = false;

/** Mini-apps (WISP 1200): `apps/1` on paired sessions and the engine's `app*` calls. Off until the web chess e2e passes
 * (marketplace PR 10): nothing is offered to contacts and every call is refused. Tests turn it on per engine
 * (`NodeOptions.apps`). */
export const APPS_ENABLED: boolean = false;
