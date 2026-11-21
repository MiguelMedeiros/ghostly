import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCardId, type AppCard } from "@ghostly/core";
import type { InstalledAppView } from "@ghostly/browser/engine/apps";
import { AppCardView } from "../../components/apps/AppCardView";
import { appErrorText } from "../../lib/apps/errors";
import { LOCKED, setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { translateWith } from "../../locales/translate";
import { LOCALES as locales } from "../i18n/locales";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.chat.card

/*
 * An Open the profile's lock overtook (`LOCKED`) is said in the person's language wherever it shows (the card, + → Apps,
 * Open again, the Apps page), never as the opener's English: the app stays mounted under the lock, and the line waits
 * there for the person once they unlock.
 */

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: DIGEST, sequence: 7, title: "Chess", version: "1.2.0", url: URL_, opened: true };
const installed = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess", version: "1.2.0",
  sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
});

beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(async () => { throw new Error(LOCKED); });
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36");
  fakeEngine.on("appList", () => [installed()]).on("appStoreList", () => []).on("appBuiltIns", () => []).on("appCheckUpdates", () => []);
  fakeEngine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer", profile: "paired-chat/1" })] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setAppOpener(null);
  forgetAppsAvailable();
  forgetInstalledApps();
});

describe("an Open the profile's lock overtook", () => {
  it("is said in every language, never as the opener's English", () => {
    const en = translateWith(locales.en, "en");
    for (const [language, messages] of Object.entries(locales)) {
      const t = translateWith(messages, language as never);
      expect(appErrorText(new Error(LOCKED), t)).toBe(t("apps.errors.locked"));
      if (language !== "en") expect(appErrorText(new Error(LOCKED), t)).not.toBe(appErrorText(new Error(LOCKED), en));
    }
    expect(appErrorText(new Error(LOCKED), en)).not.toBe(LOCKED);
  });

  for (const language of ["pt", "ar"] as const) {
    it(`the card says it in ${language}`, async () => {
      const t = translateWith(locales[language], language);
      const { user } = renderApp(<AppCardView card={CARD} mine={false} contact="Ana" linkId="link-1" peerKey="peer" />, { language });
      const card = screen.getByTestId("app-card");
      await user.click(await within(card).findByTestId("app-card-open"));
      await waitFor(() => expect(within(card).getByTestId("app-card-error")).toHaveTextContent(t("apps.errors.locked")));
      expect(within(card).getByTestId("app-card-error")).not.toHaveTextContent(LOCKED);
    });
  }
});
