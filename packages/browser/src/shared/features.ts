/** Release policy: external identity experiments are retained for future work,
 * but must not advertise capabilities, start network lookups, or expose cached
 * external profiles. This does not gate Ghostly participation authentication. */
export const EXTERNAL_IDENTITIES_ENABLED: boolean = false;
