import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Notice } from "../../components/ui/Notice";
import { useCopyKey } from "../../hooks/useCopyKey";
import { renderApp } from "../render";

// covers: proofs.badges, app.i18n

/**
 * Copy key (hooks/useCopyKey.ts: a contact's Ghostly card, the composer's, the public DID, a notice's details, the
 * chat's keys). A key is copied to be compared elsewhere: "Copied" when the clipboard still held something else made
 * the person compare the wrong key, and a browser without the Clipboard API threw on the click.
 */
function Probe() {
  const { copied, failed, copy } = useCopyKey("ghostly-key-123");
  return <button type="button" data-testid="probe" onClick={copy}>{copied ? "Copied" : failed ? "Failed" : "Copy"}</button>;
}

const clipboard = (writeText: unknown) => Object.defineProperty(navigator, "clipboard", { value: writeText === undefined ? undefined : { writeText, readText: async () => "" }, configurable: true });
const execCommand = (works: boolean) => {
  const run = vi.fn(() => works);
  Object.defineProperty(document, "execCommand", { value: run, configurable: true });
  return run;
};
const saved = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (saved) Object.defineProperty(navigator, "clipboard", saved);
  delete (document as { execCommand?: unknown }).execCommand;
});

describe("Copy key", () => {
  it("says Copied once the Clipboard API took the key", async () => {
    const writeText = vi.fn(async () => {});
    renderApp(<Probe />);
    clipboard(writeText);
    act(() => screen.getByTestId("probe").click());
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("Copied"));
    expect(writeText).toHaveBeenCalledWith("ghostly-key-123");
  });

  it("refused by the Clipboard API, tries the older route, and says Copied only when that one copies", async () => {
    renderApp(<Probe />);
    clipboard(vi.fn(async () => { throw new DOMException("Document is not focused.", "NotAllowedError"); }));
    const run = execCommand(true);
    act(() => screen.getByTestId("probe").click());
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("Copied"));
    expect(run).toHaveBeenCalledWith("copy");
  });

  it("says it failed, never Copied, when neither route copies, the Clipboard API missing included", async () => {
    for (const writeText of [vi.fn(async () => { throw new DOMException("Denied", "NotAllowedError"); }), undefined]) {
      const { unmount } = renderApp(<Probe />);
      clipboard(writeText);
      execCommand(false);
      const errors: unknown[] = [];
      const onError = (event: ErrorEvent) => errors.push(event.error);
      window.addEventListener("error", onError);
      act(() => screen.getByTestId("probe").click());
      await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("Failed"));
      window.removeEventListener("error", onError);
      expect(errors).toEqual([]);
      unmount();
    }
  });

  it("a notice's details say Not copied, in the profile's language, when the copy fails", async () => {
    const { user } = renderApp(<Notice testId="n" problem={{ tone: "error", title: "Can't reach the relays", detail: "Error: 500" }} />);
    await user.click(screen.getByTestId("n-info"));
    clipboard(vi.fn(async () => { throw new DOMException("Denied", "NotAllowedError"); }));
    execCommand(false);
    act(() => screen.getByTestId("n-copy").click());
    await waitFor(() => expect(screen.getByTestId("n-copy")).toHaveTextContent("Not copied"));
  });
});
