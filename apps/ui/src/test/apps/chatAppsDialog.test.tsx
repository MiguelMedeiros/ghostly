import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPreview, BuiltInAppOffer, InstalledAppView } from "@ghostly/browser/engine/apps";
import { ChatAppsDialog } from "../../components/apps/ChatAppsDialog";
import { setAppOpener } from "../../lib/apps/open";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.chat.card

// The chat's + → Apps (WISP 1200 § In a chat). A profile restored from a backup has the installed list, not the
// bundles (§ Where installed apps live): such an app is opened like any other, and opening it fetches its files.
const REF = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo/chess";

let run: InstalledAppView["run"];
const installed = (): InstalledAppView => ({
  ref: REF, name: "chess", publisher: REF.split("/")[0]!, fingerprint: "yz7m oxuc bd4u 8aqt", title: "Chess", tagline: "Play chess", version: "1.2.0",
  sequence: 7, digest: "d", permissions: ["chat"], view: "chat", from: "https://raw.githubusercontent.com/a/chess/HEAD/app.ghostlyapp", icon: false, installedAt: 1, updatedAt: 1,
  run, listedBy: [], unknownPublisher: false,
});

const lists = vi.fn(() => [installed()]);
const sent = vi.fn(() => ({ error: null }));
beforeEach(() => {
  run = { status: "needs-files" };
  lists.mockClear(); sent.mockClear();
  forgetInstalledApps();
  fakeEngine.on("appList", lists);
  fakeEngine.on("sendMessage", sent);
});
afterEach(() => setAppOpener(null));

async function dialog() {
  const onClose = vi.fn();
  const view = renderApp(<ChatAppsDialog linkId="link-1" name="Ana" onClose={onClose} />);
  await screen.findByTestId("chat-app");
  return { ...view, onClose };
}

describe("the chat's Apps with an app whose files are not on this device", () => {
  it("says it needs its files, and Open fetches them: the app opens and the list is read again", async () => {
    // The engine fetches the files by digest on the first open (appEntry).
    const opener = vi.fn(async () => { run = { status: "ok" }; });
    setAppOpener(opener);
    const { user, onClose } = await dialog();
    expect(screen.getByTestId("chat-app")).toHaveTextContent("Needs its files");
    expect(screen.getByTestId("chat-app")).not.toHaveTextContent("Stopped");
    expect(screen.getByTestId("chat-app-open")).toBeEnabled();

    await user.click(screen.getByTestId("chat-app-open"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(opener).toHaveBeenCalledWith(REF, "link-1", {});
    expect(sent).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(lists).toHaveBeenCalledTimes(2));
  });

  it("no source answers: it says the files are not on this device yet, and Open stays", async () => {
    setAppOpener(vi.fn(async () => { throw new Error("needs-files: This app's files are not on this device yet"); }));
    const { user, onClose } = await dialog();
    await user.click(screen.getByTestId("chat-app-open"));
    expect(await screen.findByTestId("chat-apps-error")).toHaveTextContent("Its files are not on this device yet.");
    expect(onClose).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("chat-app-open")).toBeEnabled());
    expect(screen.getByTestId("chat-app")).toHaveTextContent("Needs its files");
  });

  it.each([{ status: "revoked" }, { status: "removed", by: [{ store: "k", name: "A store", reason: "", at: 1 }] }] as InstalledAppView["run"][])("a $status version stays Stopped, with Open off", async (taken) => {
    run = taken;
    await dialog();
    expect(screen.getByTestId("chat-app")).toHaveTextContent("Stopped");
    expect(screen.getByTestId("chat-app-open")).toBeDisabled();
  });

  it("an app that may run shows its tagline", async () => {
    run = { status: "ok" };
    await dialog();
    expect(screen.getByTestId("chat-app")).toHaveTextContent("Play chess");
    expect(screen.getByTestId("chat-app-open")).toBeEnabled();
  });
});

describe("the chat's Apps with an app that comes with Ghostly, never opened here", () => {
  const offer: BuiltInAppOffer = { ref: REF, publisher: REF.split("/")[0]!, name: "chess", fingerprint: "yz7m oxuc bd4u 8aqt", digest: "d", url: "https://raw.githubusercontent.com/a/chess/HEAD/app.ghostlyapp", title: "Chess", tagline: "Play chess" };
  const carried: AppPreview = {
    digest: "d", ref: REF, publisher: offer.publisher, fingerprint: offer.fingerprint, from: offer.url, icon: null, install: "new", asks: ["chat"], carried: true,
    run: { status: "ok" }, listedBy: [], unknownPublisher: false,
    manifest: { ghostlyApp: 1, publisher: offer.publisher, name: "chess", version: "1.2.0", sequence: 7, kind: "mini-app", title: "Chess", tagline: "Play chess",
      entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  };

  it("is listed with nothing installed; Open shows what it asks first, and Allow and open opens it with the contact", async () => {
    run = { status: "ok" };
    let have = false;
    lists.mockImplementation(() => (have ? [installed()] : []));
    fakeEngine.on("appBuiltIns", () => (have ? [] : [offer])).on("appPreview", () => carried).on("appInstall", () => { have = true; return installed(); });
    const opener = vi.fn(async () => {});
    setAppOpener(opener);
    const onClose = vi.fn();
    const { user } = renderApp(<ChatAppsDialog linkId="link-1" name="Ana" onClose={onClose} />);
    const row = await screen.findByTestId("chat-built-in-app");
    expect(row).toHaveTextContent("Chess");
    expect(screen.queryByTestId("chat-apps-none")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("chat-built-in-app-open"));
    const confirm = await screen.findByTestId("app-install-confirm");
    expect(fakeEngine.callsTo("appPreview")).toEqual([{ builtIn: REF }]);
    expect(confirm).toHaveTextContent("Allow and open");
    expect(screen.getByTestId("app-carried-line")).toBeInTheDocument();
    // Nothing opened, nothing sent, until the person allows it.
    expect(opener).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();

    await user.click(confirm);
    await waitFor(() => expect(opener).toHaveBeenCalledWith(REF, "link-1", {}));
    await waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    lists.mockImplementation(() => [installed()]);
  });
});
