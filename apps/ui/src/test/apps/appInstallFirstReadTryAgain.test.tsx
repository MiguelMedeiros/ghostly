import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPreview } from "@ghostly/browser/engine/apps";
import { AppInstallDialog } from "../../components/apps/AppInstallDialog";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.page

/**
 * An install screen reads the app as it opens. When that first read failed (the host's own trouble, offline, the host
 * not reached), the screen said why, with "Try again later" in the line, and offered only Cancel: trying again meant
 * closing it and finding the listing or the chat card again. A failure that trying again may change now has Try again
 * beside Cancel, as the Apps page's: busy while it reads, the focus kept on it, a second failure a new alert.
 */

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const DIGEST = "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4";
const URL_ = "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp";
const HOST_503 = "status: The host answered 503";
const HOST_LINE = "The host had a problem (error 503). Try again later.";

const preview = (patch: Partial<AppPreview> = {}): AppPreview => ({
  digest: DIGEST, ref: REF, publisher: KEY, fingerprint: "yz7m oxuc bd4u 8aqt", from: URL_, icon: null, install: "new", asks: ["chat"],
  run: { status: "ok" }, listedBy: [], unknownPublisher: true, stage: `${DIGEST}\nscreen`,
  manifest: { ghostlyApp: 1, publisher: KEY, name: "chess", version: "1.2.0", sequence: 7, kind: "mini-app", title: "Chess", tagline: "Play chess with a contact",
    entry: "index.html", permissions: ["chat"], runtime: { host: ">=1.2", clients: ["web", "desktop"] }, license: "MIT", files: [] },
  ...patch,
});

/** Each read waits until the test answers it: `answer(p)` shows the app, `answer(new Error(...))` fails the read. */
let pending: ((r: AppPreview | Error) => void)[];
const answer = async (r: AppPreview | Error) => { await act(async () => { pending.shift()!(r); }); };
beforeEach(() => {
  forgetInstalledApps();
  pending = [];
  fakeEngine.on("appList", () => []).on("appBuiltIns", () => [])
    .on("appPreview", () => new Promise<AppPreview>((resolve, reject) => { pending.push((r) => r instanceof Error ? reject(r) : resolve(r)); }));
});
afterEach(() => { forgetInstalledApps(); vi.restoreAllMocks(); });

const open = () => renderApp(<AppInstallDialog source={{ store: "s1", ref: REF }} title="Chess" onClose={() => {}} />);
const tryAgain = () => within(screen.getByTestId("app-install")).queryByRole("button", { name: "Try again" });

describe("an install screen whose first read failed", () => {
  it("offers Try again for the host's 503, and Try again shows the app, the focus going to Install", async () => {
    open();
    await waitFor(() => expect(pending).toHaveLength(1));
    await answer(new Error(HOST_503));
    expect(within(screen.getByTestId("app-install")).getByRole("alert")).toHaveTextContent(HOST_LINE);
    const again = tryAgain();
    expect(again).not.toBeNull();
    again!.focus();
    await act(async () => { fireEvent.click(again!); });
    expect(again).toHaveAttribute("aria-busy", "true");
    expect(again).toHaveAttribute("aria-disabled", "true");
    expect(again).toHaveFocus();
    // A second press while it reads is not a second read.
    await act(async () => { fireEvent.click(again!); });
    expect(fakeEngine.callsTo("appPreview")).toHaveLength(2);
    await answer(preview());
    const dialog = screen.getByTestId("app-install");
    expect(within(dialog).getByTestId("app-publisher")).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(tryAgain()).toBeNull();
    // The button went with its line: the focus goes to Install, not the page.
    await waitFor(() => expect(within(dialog).getByTestId("app-install-confirm")).toHaveFocus());
  });

  it("says a second failure as a new alert, the focus kept on Try again", async () => {
    open();
    await waitFor(() => expect(pending).toHaveLength(1));
    await answer(new Error("offline: You are offline"));
    const before = within(screen.getByTestId("app-install")).getByRole("alert");
    expect(before).toHaveTextContent("You are offline.");
    const again = tryAgain()!;
    again.focus();
    await act(async () => { fireEvent.click(again); });
    expect(again).toHaveAttribute("aria-busy", "true");
    await answer(new Error("network: fetch failed"));
    await waitFor(() => expect(again).not.toHaveAttribute("aria-busy"));
    // The same words left in place say nothing to a screen reader: the alert is a new one.
    const after = within(screen.getByTestId("app-install")).getByRole("alert");
    expect(after).not.toBe(before);
    expect(after).toHaveTextContent("Could not reach the host.");
    expect(again).toBeInTheDocument();
    expect(again).toHaveFocus();
    expect(again).not.toHaveAttribute("aria-disabled");
  });

  it("hands the focus to the screen when what it read cannot be installed", async () => {
    open();
    await waitFor(() => expect(pending).toHaveLength(1));
    await answer(new Error("slow: That took too long on this connection"));
    const again = tryAgain()!;
    again.focus();
    await act(async () => { fireEvent.click(again); });
    await answer(preview({ run: { status: "revoked" } }));
    const dialog = screen.getByTestId("app-install");
    expect(within(dialog).queryByTestId("app-install-confirm")).toBeNull();
    await waitFor(() => expect(dialog).toHaveFocus());
  });

  it("offers no Try again for a refusal that trying again cannot change", async () => {
    for (const refusal of ["status: The host answered 404", "host: Not a link Ghostly reads apps from", "bad-signature: The signature does not match", "too-large: The bundle is over 10 MB", "removed: A store removed it", "revoked: Its publisher revoked it"]) {
      const { unmount } = open();
      await waitFor(() => expect(pending).toHaveLength(1));
      await answer(new Error(refusal));
      const dialog = screen.getByTestId("app-install");
      expect(within(dialog).getByRole("alert")).toBeInTheDocument();
      expect(tryAgain(), refusal).toBeNull();
      expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
      unmount();
    }
  });
});
