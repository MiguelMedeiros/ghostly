/**
 * The manifest, checked by its type: `ghostly-app.json` holds the same object (`ghostly app publish` writes `publisher`,
 * `files` and the next `sequence` itself).
 */
import type { AppManifest, AppManifestSource, MiniAppRequestType } from "@ghostlytools/sdk/app";

export const manifest = {
  name: "counter",
  version: "0.1.0",
  kind: "mini-app",
  title: "Counter",
  tagline: "Count together in a chat",
  entry: "index.html",
  permissions: ["chat"],
  view: "chat",
  runtime: { host: ">=1.2", clients: ["web", "desktop"] },
  license: "MIT",
} satisfies AppManifestSource;

// The types are the real ones, not `any`: each line below must fail to type check.
// @ts-expect-error `camera` is not a permission.
export const badPermission: AppManifestSource = { ...manifest, permissions: ["camera"] };
// @ts-expect-error a signed manifest has the `publisher` that `ghostly app publish` writes.
export const unsigned: AppManifest = { ...manifest, sequence: 1, ghostlyApp: 1, files: [] };
// @ts-expect-error the broker answers no `chat.read`.
export const noSuchRequest: MiniAppRequestType = "chat.read";
