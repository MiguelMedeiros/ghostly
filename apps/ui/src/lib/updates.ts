export interface FoundUpdate {
  version: string;
  /**
   * The exact build, where the platform marks one. The web app deploys many
   * builds of the same version, and putting one aside must not put the next
   * one aside with it.
   */
  build?: string;
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
}

/**
 * Every client that exists swaps this module for the one in `@ghostly/browser`,
 * which asks its host — including Desktop, which builds `/src` the same way and
 * answers with `desktop/updates.ts`. Nothing is left to do here.
 */
export const updatePlatform: UpdatePlatform | null = null;
