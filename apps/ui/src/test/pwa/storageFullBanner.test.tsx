import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageFullBanner } from "../../components/StorageFullBanner";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { renderApp } from "../render";
// covers: chat.paired.storage

/**
 * The page's storage full: a chat's session it refused is kept by the page and shown (lib/storage `unsaved`), but gone at
 * a reload until the engine speaks. The person is told, with what to do about it.
 */
const session = (messages: ChatSession["messages"]): ChatSession => ({ id: "s1", mySeedB64: "seed", peerPubKeyB64: "peer", encKeyB64: "enc", messages, createdAt: 1 });
const text = { id: "peer_1", text: "hi", sender: "peer" as const, timestamp: 2 };

afterEach(() => vi.restoreAllMocks());

describe("the storage-full notice", () => {
  it("shows while a chat's copy could not be stored, with the next step, and goes once it is", async () => {
    saveSession(session([]));
    renderApp(<StorageFullBanner />);
    expect(screen.queryByTestId("storage-full-banner")).toBeNull();

    const setItem = localStorage.setItem.bind(localStorage);
    const full = vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (key === "ghostly_s1") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      setItem(key, value);
    });
    await act(async () => { saveSession(session([text])); });
    expect(screen.getByTestId("storage-full-banner")).toHaveTextContent("Storage full · New messages still show here. To keep them after a reload, delete chats or profiles you no longer need.");

    full.mockRestore();
    await act(async () => { saveSession(session([text, { ...text, id: "peer_2", timestamp: 3 }])); });
    expect(screen.queryByTestId("storage-full-banner")).toBeNull();
  });
});
