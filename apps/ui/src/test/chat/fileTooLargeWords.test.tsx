// happy-dom has no IndexedDB: the file store keeps what is sent in this one.
import "fake-indexeddb/auto";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.large.offer, files.large.limits

const PEER ="peer".padEnd(52, "p");

/** A paired chat in Portuguese, live, with a contact whose app is described by `link`. */
function openChat(link: Record<string, unknown>) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000 });
  const utils = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { language: "pt" });
  utils.engine.on("sendFile", () => undefined)
    .update({ links: [linkView({ peerPubKeyZ32: PEER, profile: "paired-chat/1", ...link } as never)] });
  return utils;
}

/** A file that says it is `size` bytes, without holding them. */
function fileOf(size: number) {
  const file = new File(["x"], "big.bin", { type: "application/octet-stream" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("a file the contact cannot take is refused in the app's language", () => {
  it("a files/3 contact without room for it: the translated title and how much is free", async () => {
    const { engine } = openChat({ capabilities: { files: true, largeFiles: true }, peerFileRoom: 2_000_000 });
    fireEvent.change(await screen.findByTestId("file-input"), { target: { files: [fileOf(5_000_000)] } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Sem espaço no dispositivo do contato\. .+ livres\./);
    expect(alert).not.toHaveTextContent("Not enough space");
    expect(engine.callsTo("sendFile")).toHaveLength(0);
  });

  it("an older contact's app, past its limit: the translated title and its maximum", async () => {
    const { engine } = openChat({ capabilities: { files: true } });
    fireEvent.change(await screen.findByTestId("file-input"), { target: { files: [fileOf(2 ** 40)] } });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/^Grande demais para o app do contato\. Máx\. .+ até ele atualizar o Ghostly\./);
    expect(engine.callsTo("sendFile")).toHaveLength(0);
  });
});
