export interface FoundUpdate {
  version: string;
  /**
   * The exact build, where the platform marks one. The web app deploys many
   * builds of the same version, and putting one aside must not put the next
   * one aside with it.
   */
  build?: string;
  /**
   * The same version, built again, found because this build's files are gone
   * from the server. The banner says a new build instead of naming a version
   * the client already runs. Never set for another version (a rollback found
   * the same way is named by its version, like any update).
   */
  replaced?: boolean;
  /** Release notes, where the platform publishes them. */
  notes?: string;
  /**
   * What putting it in place takes here. `manual` means this client cannot
   * install it — a `.deb` desktop build, an unpacked extension — and the UI
   * offers the download instead of a button.
   */
  apply: "restart" | "reload" | "manual";
  /** The platform's own handle on the update. Nothing outside the platform looks inside. */
  handle?: unknown;
}

/**
 * Finding out that a new version exists, and putting it in place. What that
 * means differs per client: the desktop app downloads and restarts into it,
 * the web app reloads the tab, and an unpacked extension can only be pointed
 * at the download.
 *
 * Every implementation asks the network only when the user allows it: the
 * check is a request that says this device runs Ghostly, so it is a setting.
 */
export interface UpdatePlatform {
  /** Where someone installing by hand should go. */
  readonly downloadUrl: string;
  /** The newest published version, or null when this client already runs it. */
  check(): Promise<FoundUpdate | null>;
  /** Puts it in place. Never called for `apply: "manual"`. */
  install(update: FoundUpdate, onProgress?: (fraction: number) => void): Promise<void>;
  /**
   * Calls `listener` when the platform learns that a file of this build is gone
   * from the server (the web app's worker got a 404 for one): a deploy replaced
   * it, and the app checks at once. Returns what stops listening. Left out where
   * a platform cannot tell.
   */
  onBuildGone?(listener: () => void): () => void;
}

/**
 * Every client that exists swaps this module for the one in `@ghostly/browser`,
 * which asks its host — including Desktop, which builds `/src` the same way and
 * answers with `desktop/updates.ts`. Nothing is left to do here.
 */
export const updatePlatform: UpdatePlatform | null = null;
