import type { UpdatePlatform } from "../../../../src/lib/updates";
import { RELEASES_URL } from "../../../../src/lib/settings";
import { getBrowserHost } from "../host";

/**
 * Browser clients: the host knows where its own new versions are published
 * and what applying one means there — a reload in the web app, a download for
 * an unpacked extension. A host that says nothing has no updater at all, and
 * the UI stays quiet.
 */
export const updatePlatform: UpdatePlatform | null = {
  get downloadUrl() {
    return getBrowserHost().updates?.downloadUrl ?? RELEASES_URL;
  },
  check: () => getBrowserHost().updates?.check() ?? Promise.resolve(null),
  install: (update) => {
    const updates = getBrowserHost().updates;
    if (!updates) throw new Error("This client cannot install updates");
    return updates.install(update);
  },
};
