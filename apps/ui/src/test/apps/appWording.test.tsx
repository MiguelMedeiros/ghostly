import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppPreview, InstalledAppView } from "@ghostly/browser/engine/apps";
import { AppInstallDialog, InstalledAppDialog } from "../../components/apps/AppInstallDialog";
import { fakeEngine } from "../fakeEngine";
import { LANGUAGES, LOCALES, flatten } from "../i18n/locales";
import { renderApp } from "../render";

// covers: apps.page

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";

const installed = (patch: Partial<InstalledAppView> = {}): InstalledAppView => ({
  ref: REF, name: "chess", publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess with a contact",
  version: "1.2.0", sequence: 7, digest: DIGEST, permissions: ["chat"], view: "chat", from: URL_, icon: false, installedAt: 1, updatedAt: 1,
  run: { status: "ok" }, listedBy: [], unknownPublisher: true, ...patch,
});
const preview = (patch: Partial<AppPreview> = {}): AppPreview => ({
  digest: DIGEST, ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: URL_, icon: null, install: "new", asks: ["chat"],
  run: { status: "ok" }, listedBy: [], unknownPublisher: true,
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "2.0.1", sequence: 12, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  ...patch,
});
const details = (app: InstalledAppView, language?: "pt") =>
  renderApp(<InstalledAppDialog app={app} onClose={() => {}} onOpen={() => {}} />, language && { language });

afterEach(() => { vi.restoreAllMocks(); });

describe("two copies of one version: the line names no number the person never saw", () => {
  it("on the details screen, beside the version in its header", () => {
    details(installed({ equivocation: { sequence: 7, at: 1 } }));
    expect(screen.getByTestId("app-details")).toHaveTextContent("Version 1.2.0");
    expect(screen.getByTestId("app-equivocation")).toHaveTextContent("Two different copies of this version exist. Ghostly kept the one you have.");
    expect(screen.getByTestId("app-equivocation")).not.toHaveTextContent(/\d/);
  });

  it("on the details screen in Portuguese", () => {
    details(installed({ equivocation: { sequence: 7, at: 1 } }), "pt");
    expect(screen.getByTestId("app-equivocation")).toHaveTextContent("Existem duas cópias diferentes desta versão. O Ghostly manteve a que você tem.");
    expect(screen.getByTestId("app-equivocation")).not.toHaveTextContent(/\d/);
  });

  it("on the install screen", async () => {
    fakeEngine.on("appPreview", () => preview({ install: "equivocation" }));
    renderApp(<AppInstallDialog source={{ url: URL_ }} onClose={() => {}} />);
    const line = await screen.findByTestId("app-install-blocked");
    expect(line).toHaveTextContent("Two different copies of this version exist.");
    expect(line).not.toHaveTextContent("12");
  });
});

describe("a waiting update that adds no permission any more", () => {
  for (const [language, ready, asks] of [
    [undefined, "Version 1.4.0 is ready.", "This update also asks to"],
    ["pt", "A versão 1.4.0 está pronta.", "Esta atualização também pede para"],
  ] as const) {
    it(`says it is ready, with no "also asks to" over an empty list (${language ?? "en"})`, () => {
      details(installed({ pending: { sequence: 9, version: "1.4.0", added: [] } }), language);
      const update = screen.getByTestId("app-update");
      expect(update).toHaveTextContent(ready);
      expect(update).not.toHaveTextContent(asks);
      expect(within(update).queryByTestId("app-permissions")).not.toBeInTheDocument();
      expect(within(update).getByTestId("app-update-accept")).toBeInTheDocument();
    });
  }
});

describe("an installed app's removal says one verb on its button, its question and its confirm", () => {
  for (const run of [{ status: "ok" }, { status: "revoked" }, { status: "removed", by: [{ store: "s", name: "Store", reason: "spam", at: 1 }] }, { status: "needs-files" }] as InstalledAppView["run"][]) {
    it(`whatever the app's state (${run.status})`, async () => {
      const { user } = details(installed({ run }));
      expect(screen.getByTestId("app-uninstall-open")).toHaveTextContent(/^Uninstall$/);
      await user.click(screen.getByTestId("app-uninstall-open"));
      expect(within(screen.getByTestId("app-uninstall")).getByRole("heading")).toHaveTextContent("Uninstall Chess?");
      expect(screen.getByTestId("app-uninstall-confirm")).toHaveTextContent(/^Uninstall$/);
    });
  }
});

describe("whoever signs an app has one name in each language", () => {
  // The spec's word is "publisher" (WISP 1200); each language keeps the one its "Unknown publisher" heading uses.
  const OTHER: Record<string, RegExp> = {
    en: /\bmakers?\b/i, pt: /\bautor|quem o fez|quem os fez/i, es: /\bautor|quién la hizo/i, fr: /\bauteur|qui l'a faite/i,
    it: /\bautor[ei]\b|chi l'ha fatta/i, ar: /صانع|صنعه/, ja: /作者/, zh: /作者|制作/,
  };
  it("no apps text names the publisher with another word", () => {
    expect(Object.keys(OTHER).sort()).toEqual([...LANGUAGES].sort());
    const found: string[] = [];
    for (const language of LANGUAGES) {
      for (const [key, value] of flatten(LOCALES[language].apps)) {
        if (typeof value === "string" && OTHER[language]!.test(value)) found.push(`${language} apps.${key}: ${value}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("the panel's stopped line and the details' revoked line say the same word", () => {
    expect(flatten(LOCALES.en.apps).get("view.stoppedRevoked")).toBe("{{title}} was stopped: its publisher revoked this version");
    expect(flatten(LOCALES.en.apps).get("install.revoked")).toBe("Its publisher revoked this version.");
    expect(flatten(LOCALES.pt.apps).get("view.stoppedRevoked")).toBe("{{title}} foi parado: o publicador revogou esta versão");
    expect(flatten(LOCALES.pt.apps).get("install.revoked")).toBe("O publicador revogou esta versão.");
  });
});
