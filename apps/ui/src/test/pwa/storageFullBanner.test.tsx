import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageFullBanner } from "../../components/StorageFullBanner";
import { deleteSession, saveSession } from "../../lib/storage";
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

  /** localStorage holding at most `quota` characters, keys and values, as a browser's does. */
  function fillTo(quota: number) {
    const setItem = localStorage.setItem.bind(localStorage);
    const used = (except: string) => Object.keys(localStorage).filter((k) => k !== except).reduce((n, k) => n + k.length + (localStorage.getItem(k)?.length ?? 0), 0);
    return vi.spyOn(localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (used(key) + key.length + value.length > quota) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      setItem(key, value);
    });
  }
  const long = (id: string, size: number): ChatSession => ({ ...session([{ ...text, id: `peer_${id}`, text: "x".repeat(size) }]), id });

  it("goes once deleting a chat makes room, and the held chat is stored", async () => {
    localStorage.clear();
    saveSession(long("old", 6000));
    saveSession(session([]));
    renderApp(<StorageFullBanner />);
    fillTo(7000);
    await act(async () => { saveSession(session([{ ...text, text: "y".repeat(2000) }])); });
    expect(screen.getByTestId("storage-full-banner")).toBeInTheDocument();

    await act(async () => { deleteSession("old"); });
    expect(screen.queryByTestId("storage-full-banner")).toBeNull();
    expect(localStorage.getItem("ghostly_s1")).toContain("y".repeat(2000));
  });

  it("stays when the delete did not make enough room", async () => {
    localStorage.clear();
    saveSession(long("old", 6000));
    saveSession(long("small", 100));
    saveSession(session([]));
    renderApp(<StorageFullBanner />);
    fillTo(7000);
    await act(async () => { saveSession(session([{ ...text, text: "y".repeat(2000) }])); });
    await act(async () => { deleteSession("small"); });
    expect(screen.getByTestId("storage-full-banner")).toBeInTheDocument();
    expect(localStorage.getItem("ghostly_s1")).not.toContain("y".repeat(2000));
  });

  it("goes once room is made outside this page (another profile's chats deleted), at the storage event or the page's focus", async () => {
    for (const event of [() => new StorageEvent("storage"), () => new FocusEvent("focus")]) {
      localStorage.clear();
      localStorage.setItem("ghostly_other_profile", "z".repeat(6000));
      saveSession(session([]));
      const view = renderApp(<StorageFullBanner />);
      const full = fillTo(7000);
      await act(async () => { saveSession(session([{ ...text, text: "y".repeat(2000) }])); });
      expect(screen.getByTestId("storage-full-banner")).toBeInTheDocument();

      localStorage.removeItem("ghostly_other_profile");
      await act(async () => { window.dispatchEvent(event()); });
      expect(screen.queryByTestId("storage-full-banner")).toBeNull();
      expect(localStorage.getItem("ghostly_s1")).toContain("y".repeat(2000));
      full.mockRestore();
      view.unmount();
    }
  });
});
