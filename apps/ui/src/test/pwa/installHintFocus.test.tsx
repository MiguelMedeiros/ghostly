import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { InstallHint, InstallSteps } from "../../components/InstallApp";
import { resetInstallPrompt, watchInstallPrompt } from "../../lib/installPrompt";
import { renderApp } from "../render";
// covers: app.pwa.install-entry

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

afterEach(() => {
  vi.restoreAllMocks();
  resetInstallPrompt();
  localStorage.clear();
});

const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

/** The chat list's header (New chat) above the hint, and the steps sheet beside the app, as the sidebar has them. */
function list() {
  return renderApp(<>
    <button type="button" data-testid="sidebar-new-chat">New chat</button>
    <InstallHint hasChats />
    <InstallSteps />
  </>);
}

function offer() {
  window.dispatchEvent(Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: vi.fn(() => Promise.resolve()),
    userChoice: Promise.resolve({ outcome: "dismissed" }),
  }));
}

/**
 * Not now and Install put the hint away from under the focused button (apps/ui/src/components/InstallApp.tsx): the key
 * that pressed one lands on New chat above it, never on the page's body.
 */
describe("the install hint by keyboard", () => {
  it("Not now gives the focus to New chat", async () => {
    watchInstallPrompt();
    offer();
    const { user } = list();
    screen.getByTestId("install-hint-later").focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("install-hint")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus());
  });

  it("Install, with the browser's prompt, gives the focus to New chat", async () => {
    watchInstallPrompt();
    offer();
    const { user } = list();
    screen.getByTestId("install-hint-install").focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("install-hint")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus());
  });

  it("Install in Safari focuses Got it, and Got it gives the focus to New chat", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(SAFARI_MAC);
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(0);
    watchInstallPrompt();
    const { user } = list();
    screen.getByTestId("install-hint-install").focus();
    await user.keyboard("{Enter}");
    const done = await screen.findByTestId("install-steps-done");
    await waitFor(() => expect(done).toHaveFocus());
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("install-steps")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("sidebar-new-chat")).toHaveFocus());
  });
});
