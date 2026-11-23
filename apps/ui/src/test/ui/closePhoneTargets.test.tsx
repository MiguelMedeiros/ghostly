import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NostrDraft, NostrDraftRequest } from "@ghostly/browser/nostr/types";
import { NostrPublishDialog } from "../../components/nostr/NostrPublishDialog";
import { OpenFailureNotice } from "../../components/OpenFailureNotice";
import { StoppedInBackgroundBanner } from "../../components/StoppedInBackgroundBanner";
import { Toast } from "../../components/ui/Toast";
import { reportOpenFailure } from "../../lib/openFailure";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.accessibility

/*
 * A × takes a tap in 44 px on a phone, as the app's other buttons there: the floating card's and the link-failure
 * card's were 32 px boxes, the Nostr publish dialog's 40 px and Android's stopped-in-background banner's 20 px, none
 * grown. They carry `.tap-target` (index.css), which grows where a tap lands without moving them.
 */

vi.mock("../../lib/stayConnected", async (actual) => ({ ...await actual<typeof import("../../lib/stayConnected")>(), useStoppedInBackground: () => true }));

/** happy-dom has no <dialog> modal; the dialog only needs to open. */
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.open = true; };

describe("a × on a phone", () => {
  it("the floating card's: a tap lands in 44 px", () => {
    renderApp(<Toast toast={{ id: 1, tone: "error", text: "Passwords do not match", ms: 5_000 }} onDismiss={() => {}} />);
    expect(screen.getByTestId("toast-close")).toHaveClass("tap-target");
  });

  it("the link-failure card's: a tap lands in 44 px, clear of the ⓘ beside it", async () => {
    renderApp(<OpenFailureNotice />);
    act(() => reportOpenFailure(new Error("Not a web link")));
    const close = await screen.findByTestId("open-failure-close");
    expect(close).toHaveClass("tap-target");
    // The ⓘ ends 12 px past its box on a phone and the × begins 6 px before its own: 10 px apart, the ⓘ's area would
    // take the ×'s edge. 18 px apart on a phone, each keeps its 44 px.
    expect(screen.getByTestId("open-failure-info")).toBeInTheDocument();
    expect(close).toHaveClass("max-md:ms-2");
  });

  it("the Nostr publish dialog's: a tap lands in 44 px", async () => {
    fakeEngine.on("nostrDraft", async () => ({ draftId: "d1", subject: "npub1me", template: { kind: 1, created_at: 1, tags: [], content: "hi" }, notice: "", summary: "Post a note", relays: ["wss://relay.example"] }) as NostrDraft);
    const request: NostrDraftRequest = { subject: "npub1me", action: "note", content: "hi" };
    renderApp(<NostrPublishDialog request={request} onClose={() => {}} />);
    expect(await screen.findByTestId("nostr-publish-close")).toHaveClass("tap-target");
  });

  it("Android's stopped-in-background banner: the × and Open settings each take a tap in 44 px", () => {
    renderApp(<StoppedInBackgroundBanner />);
    const close = screen.getByTestId("stopped-in-background-dismiss");
    const settings = screen.getByTestId("stopped-in-background-settings");
    expect(close).toHaveClass("tap-target");
    expect(settings).toHaveClass("tap-target");
    // The 20 px × grows 12 px each way: 10 px from Open settings, its area would take Open settings' edge.
    expect(close).toHaveClass("max-md:ms-1");
  });
});
