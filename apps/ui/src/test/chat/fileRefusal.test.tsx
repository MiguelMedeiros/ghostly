import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refusalText } from "@ghostly/core";
import { FileBubble } from "../../components/FileBubble";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import type { Language } from "../../lib/settings";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.large.limits, files.large.integrity

// A sent file the contact's app refused (files/3 `pf-refuse`): its reason and next step in the app's language, in the
// status and behind the ⓘ; an error the app does not know stays English behind the ⓘ, marked so (dir=ltr lang=en).

const show = (error: string, language: Language) => {
  const transfer = { state: "failed", direction: "out", transferred: 0, size: 5_000_000, error, retry: true } as FileTransferState;
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: { "chat1-out-x": transfer } });
  const view = renderApp(<FileBubble file={{ id: "chat1-out-x", name: "photo.jpg", size: 5_000_000, mime: "image/jpeg" }} peerName="Ana" />, { language });
  fireEvent.click(screen.getByTestId("file-why"));
  return { view, status: screen.getByTestId("file-status").textContent, why: screen.getByTestId("file-why-text") };
};

beforeEach(() => {
  vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(null);
  fakeEngine.on("fileAction", () => undefined);
});

describe("a sent file the contact's app refused", () => {
  const error = (why: string) => refusalText(why, why === "no-room" ? 1_200_000 : undefined).error;

  it.each([
    ["no-room", "Sem espaço no dispositivo do contato", "1.1 MB livres. Peça que liberem espaço e envie de novo."],
    ["too-many", "Seu contato tem arquivos demais esperando", "Tente de novo mais tarde."],
    ["damaged", "O arquivo chegou danificado", "Envie de novo."],
    ["expired", "Não foi aceito a tempo", "Envie de novo."],
    ["other", "Seu contato não pôde receber este arquivo", "Envie de novo."],
  ])("%s: the reason in the status, the next step behind the ⓘ, in the language", (why, status, next) => {
    const shown = show(error(why), "pt");
    expect(shown.status).toBe(status);
    expect(shown.why).toHaveTextContent(next);
    shown.view.unmount();
  });

  it("no room, with nothing said of the room left", () => {
    const shown = show(refusalText("no-room").error, "en");
    expect(shown.status).toBe("No room on your contact's device");
    expect(shown.why).toHaveTextContent("Ask them to make room, then send it again.");
  });

  it.each<Language>(["es", "fr", "it", "ja", "zh", "ar"])("%s: none of it in English", (language) => {
    for (const why of ["no-room", "too-many", "damaged", "expired", "other"]) {
      const english = show(error(why), "en");
      const said = { status: english.status, why: english.why.textContent };
      english.view.unmount();
      const shown = show(error(why), language);
      expect(shown.status, why).not.toBe(said.status);
      expect(shown.why.textContent, why).not.toBe(said.why);
      expect(shown.why, why).not.toHaveAttribute("lang", "en");
      shown.view.unmount();
    }
  });

  it("an error the app does not know stays English behind the ⓘ, laid out and read as English", () => {
    const shown = show("Connection lost", "ar");
    expect(shown.why).toHaveTextContent("Connection lost");
    expect(shown.why).toHaveAttribute("dir", "ltr");
    expect(shown.why).toHaveAttribute("lang", "en");
  });
});
