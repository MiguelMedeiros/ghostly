/**
 * @ghostlytools/sdk/app: what a mini-app (WISP 1200, Apps) is written against. The `window.ghostly` API the runner
 * gives an app, the broker's messages and refusal codes, the limits the broker enforces, and the manifest
 * (`ghostly-app.json`) that `ghostly app publish` signs into a bundle.
 *
 * Nothing in it imports anything at run time, so an app's single-file bundle takes only what it uses: the types, plus
 * `MINI_APP_LIMITS`, `MINI_APP_ERROR_CODES` and `miniAppErrorCode`. The client reads the same module, so the two cannot
 * drift.
 *
 *   import type { MiniAppApi } from "@ghostlytools/sdk/app";
 *   declare global { interface Window { ghostly: MiniAppApi } }
 */

import type { AppManifestDraft } from "../../core/src/appBundle";

// The API inside the sandbox and the broker's messages
export type {
  MiniAppJson, MiniAppContext, MiniAppPeerEvent, MiniAppApi, MiniAppRequestType, MiniAppRequest, MiniAppAnswer, MiniAppEvent, MiniAppErrorCode,
} from "../../core/src/miniApp";
export { MINI_APP_LIMITS, MINI_APP_ERROR_CODES, miniAppErrorCode } from "../../core/src/miniApp";

// The manifest (types only: the checks are in `ghostly app publish` and `ghostly app verify`)
export type { AppManifest, AppManifestDraft, AppFileEntry, AppPermission, AppViewMode, AppClient, AppBundleRefusal } from "../../core/src/appBundle";

/**
 * `ghostly-app.json`, the manifest as a publisher writes it: everything but `publisher` and `files`, which
 * `ghostly app publish` writes from the key and the folder, and `sequence`, which it raises by itself when left out.
 */
export type AppManifestSource = Omit<AppManifestDraft, "sequence"> & { sequence?: number };
