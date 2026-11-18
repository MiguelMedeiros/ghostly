import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPreview, BuiltInAppOffer, InstalledAppView } from "@ghostly/browser/engine/apps";
import { BUILT_IN_APPS } from "@ghostly/browser/engine/appDefaults";
import { AppFetchError } from "@ghostly/browser/engine/appFetch";
import { AppInstallDialog } from "../../components/apps/AppInstallDialog";
import { Apps } from "../../pages/Apps";
import { readBuiltInApp } from "../../lib/apps/builtIns";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { translateWith } from "../../locales/translate";
import { LOCALES } from "../i18n/locales";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
// covers: apps.built-in

/*
 * A built-in app's first Open reads this client's own copy of it (lib/apps/builtIns.ts), kept for use offline only
 * once read. When that read fails, the install screen says why in the app's words: offline or the host's trouble as a
 * failure that may pass, with Try again; a copy that did not load at all, or an app no longer offered here, as that,
 * never as an app Ghostly refused, and with nothing in English behind an ⓘ.
 */

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

const CHESS = BUILT_IN_APPS[0]!;
const KEY = CHESS.publisher;
const REF = `${KEY}/chess`;
const STAGE = `${CHESS.digest}\nscreen`;
const preview = (): AppPreview => ({
  digest: CHESS.digest, ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: CHESS.url, icon: null, install: "new", asks: [],
  run: { status: "ok" }, listedBy: [], unknownPublisher: false, stage: STAGE, carried: true,
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "1.0.0", sequence: 1, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: [], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
});
const installed = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.0.0", sequence: 1, digest: CHESS.digest, permissions: [], view: "full", from: CHESS.url, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: false, builtIn: true,
});

/** How the client's host answers a read of its copy: offline, or the host's response. */
let online = true;
let answer: () => Promise<Response> = async () => new Response("", { status: 200 });

/**
 * The engine's preview of a built-in app (engine/apps.ts `bundled`): the client's read, a failure that may pass as it
 * came (offline, the host not reached or in trouble), any other as `not-carried`.
 */
async function previewBuiltIn(): Promise<AppPreview> {
  try {
    await readBuiltInApp(CHESS);
  } catch (error) {
    const passing = error instanceof AppFetchError && (error.code === "offline" || error.code === "network" || (error.status ?? 0) >= 500);
    throw passing ? new Error(error.message) : new Error("not-carried: This build does not carry this app");
  }
  return preview();
}

beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  online = true;
  answer = async () => new Response("", { status: 200 });
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  vi.stubGlobal("fetch", vi.fn(() => (online ? answer() : Promise.reject(new TypeError("Failed to fetch")))));
  fakeEngine.on("appPreview", () => previewBuiltIn());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setAppOpener(null); });

/** The install screen of its first Open, once its read failed: what it says, and its buttons. */
async function failedScreen(language: "en" | "pt" | "ar") {
  const t = translateWith(LOCALES[language], language);
  const view = renderApp(<AppInstallDialog source={{ builtIn: REF }} title="Chess" openAfter onClose={() => {}} />, { language });
  const dialog = await screen.findByTestId("app-install");
  const error = await within(dialog).findByTestId("app-install-error");
  return { t, dialog, error, ...view };
}

/** No English of the engine's or the host's anywhere on the screen, and nothing said as refused. */
function saysNothingRaw(dialog: HTMLElement, t: ReturnType<typeof translateWith>) {
  expect(within(dialog).queryByTestId("app-install-error-info")).not.toBeInTheDocument();
  for (const raw of ["This build does not carry this app", "This app does not come with Ghostly here", "Failed to fetch", "Offline", "The host answered"]) {
    expect(dialog).not.toHaveTextContent(raw);
  }
  expect(dialog).not.toHaveTextContent(t("apps.errors.refused"));
}

describe("a built-in app's first Open whose copy did not load", () => {
  for (const language of ["en", "pt", "ar"] as const) {
    it(`offline, or the host's own trouble, says so with Try again (${language})`, async () => {
      online = false;
      const first = await failedScreen(language);
      expect(first.error).toHaveTextContent(first.t("apps.errors.offline"));
      expect(within(first.dialog).getByTestId("app-install-read-again")).toHaveTextContent(first.t("apps.page.tryAgain"));
      saysNothingRaw(first.dialog, first.t);
      first.unmount();

      online = true;
      answer = async () => new Response("", { status: 503 });
      const second = await failedScreen(language);
      expect(second.error).toHaveTextContent(second.t("apps.errors.hostProblem", { status: 503 }));
      expect(within(second.dialog).getByTestId("app-install-read-again")).toBeInTheDocument();
      saysNothingRaw(second.dialog, second.t);
    });

    it(`a copy the host no longer has says it did not load, and how to get it (${language})`, async () => {
      answer = async () => new Response("not found", { status: 404 });
      const { t, dialog, error } = await failedScreen(language);
      expect(error).toHaveTextContent(t("apps.errors.notCarried"));
      // A read again would find the same nothing: a reload brings this build's file.
      expect(within(dialog).queryByTestId("app-install-read-again")).not.toBeInTheDocument();
      saysNothingRaw(dialog, t);
    });

    it(`an app no longer offered here says that, in its own words (${language})`, async () => {
      fakeEngine.on("appPreview", () => { throw new Error("not-offered: This app does not come with Ghostly here"); });
      const { t, dialog, error } = await failedScreen(language);
      expect(error).toHaveTextContent(t("apps.errors.notOffered"));
      expect(t("apps.errors.notOffered")).not.toBe(t("apps.errors.notCarried"));
      expect(within(dialog).queryByTestId("app-install-read-again")).not.toBeInTheDocument();
      saysNothingRaw(dialog, t);
    });
  }

  it("Try again once back online reads it, and Allow and open opens the app", async () => {
    const opened = vi.fn(async () => {});
    setAppOpener(opened);
    const offer: BuiltInAppOffer = { ref: REF, publisher: KEY, name: "chess", fingerprint: "yz7m oxuc bd4u 8aqt", digest: CHESS.digest, url: CHESS.url, title: "Chess", tagline: "Play chess with a contact" };
    let have = false;
    fakeEngine.on("appList", () => (have ? [installed()] : [])).on("appBuiltIns", () => (have ? [] : [offer]))
      .on("appStoreList", () => []).on("appCheckUpdates", () => [])
      .on("appInstall", () => { have = true; return installed(); });
    online = false;
    const { user } = renderApp(<Apps />, { route: "/apps" });
    await user.click(await screen.findByTestId("built-in-app-open"));
    const dialog = await screen.findByTestId("app-install");
    expect(await within(dialog).findByTestId("app-install-error")).toHaveTextContent("You are offline.");
    expect(fakeEngine.callsTo("appInstall")).toEqual([]);

    online = true;
    await user.click(within(dialog).getByTestId("app-install-read-again"));
    const confirm = await within(dialog).findByTestId("app-install-confirm");
    expect(within(dialog).queryByTestId("app-install-error")).not.toBeInTheDocument();
    expect(confirm).toHaveTextContent("Allow and open");
    await user.click(confirm);
    await waitFor(() => expect(opened).toHaveBeenCalledWith(REF, null, expect.anything()));
    expect(fakeEngine.callsTo("appInstall")).toEqual([{ stage: STAGE, digest: CHESS.digest, grant: [], asks: [] }]);
  });
});
