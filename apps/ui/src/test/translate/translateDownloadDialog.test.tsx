import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { TranslateDownloadDialog } from "../../components/TranslateDownloadDialog";
import { renderApp } from "../render";

/*
 * The question asked before languages download for translation. happy-dom has no modal dialog: showModal() here opens
 * it and nothing else, so the focus seen is the dialog's own.
 */
const showModal = HTMLDialogElement.prototype.showModal;
const MB = 1024 * 1024;

describe("the translation download question", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.open = true; };
    vi.stubEnv("VITE_TRANSLATE", "1");
  });
  afterEach(() => {
    HTMLDialogElement.prototype.showModal = showModal;
    vi.unstubAllEnvs();
  });

  function ask(props: Partial<Parameters<typeof TranslateDownloadDialog>[0]> = {}, language?: "fr") {
    const onNotNow = vi.fn(), onDownload = vi.fn();
    renderApp(<TranslateDownloadDialog from="pt" to="en" back bytes={73 * MB} engine={false}
      onNotNow={onNotNow} onDownload={onDownload} {...props} />, { language });
    return { onNotNow, onDownload };
  }

  it("says which languages, how big, and that Mozilla's servers see the request", async () => {
    ask();
    const dialog = await screen.findByTestId("translate-download");
    expect(dialog).toHaveAccessibleName("Download translation?");
    expect(screen.getByTestId("translate-download-pair")).toHaveTextContent("Portuguese to English and back, 73 MB");
    expect(dialog).toHaveAccessibleDescription(/Mozilla's servers/);
    expect(screen.queryByTestId("translate-download-engine")).toBeNull();
  });

  it("says one way, and that the engine comes with the first download", async () => {
    ask({ from: "it", to: "en", back: false, bytes: 84.4 * MB, engine: true });
    expect(await screen.findByTestId("translate-download-pair")).toHaveTextContent("Italian to English, 84 MB");
    expect(screen.getByTestId("translate-download-engine")).toHaveTextContent(/translation engine.*GitHub/);
  });

  it("downloads only on Download; Not now, which has the focus, and Escape leave it", async () => {
    const { onNotNow, onDownload } = ask();
    await waitFor(() => expect(screen.getByTestId("translate-download-not-now")).toHaveFocus());
    fireEvent.click(screen.getByTestId("translate-download-not-now"));
    fireEvent(screen.getByTestId("translate-download"), new Event("cancel", { cancelable: true }));
    expect(onNotNow).toHaveBeenCalledTimes(2);
    expect(onDownload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("translate-download-yes"));
    expect(onDownload).toHaveBeenCalledOnce();
  });

  it("names the languages in the app's language", async () => {
    ask({}, "fr");
    expect(await screen.findByTestId("translate-download-pair")).toHaveTextContent(/^Portugais vers anglais et retour, 73 Mo$/);
    expect(screen.getByTestId("translate-download-yes")).toHaveTextContent("Télécharger");
  });

  it("is not there in a build without translation (VITE_TRANSLATE)", () => {
    vi.stubEnv("VITE_TRANSLATE", "");
    ask();
    expect(screen.queryByTestId("translate-download")).toBeNull();
  });
});
