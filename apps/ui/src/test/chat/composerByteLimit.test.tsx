import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { setStorageProfile as setProfile } from "../../lib/storage";
import { renderApp } from "../render";

// covers: chat.paired.send

/**
 * A chat's message is at most 16 KiB of UTF-8 (the engine's limit), not 16,384 characters. Seen 2026-10-08 on dev: a
 * paired chat's field took 16,300 "é" (32,600 bytes), its counter said 84 left, and Send came back with the engine's
 * English "Message exceeds 16384 UTF-8 bytes." in every language.
 */
const onSend = vi.fn(async (_text: string) => null as string | null);
afterEach(() => { onSend.mockClear(); localStorage.clear(); sessionStorage.clear(); setProfile(""); });

function composer(extra: Partial<Parameters<typeof MessageInput>[0]> = {}) {
  return renderApp(<LockScreenProvider><MessageInput draftId="bytes" onSend={onSend} maxLength={16_384} textBytes={16_384} {...extra} /></LockScreenProvider>);
}
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

describe("the composer counts a message's bytes", () => {
  it("a text under 16,384 characters but over 16 KiB stays in the field with why, and nothing is sent", async () => {
    composer();
    fireEvent.change(field(), { target: { value: "é".repeat(16_300) } });
    // Over the limit, the count says so: not the 84 characters left.
    expect(screen.getByTestId("composer-left")).toHaveTextContent("-16216 B");
    await act(async () => { fireEvent.keyDown(field(), { key: "Enter" }); });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("That is too long to send (32,600 bytes, the limit is 16,384). Shorten it, or send it as a file.");
    expect(field().value).toHaveLength(16_300);
  });

  it("emoji count four bytes each: 4,096 go, one more does not", async () => {
    composer();
    fireEvent.change(field(), { target: { value: "👻".repeat(4_097) } });
    await act(async () => { fireEvent.keyDown(field(), { key: "Enter" }); });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: "👻".repeat(4_096) } });
    expect(screen.getByTestId("composer-left")).toHaveTextContent("0 B");
    await act(async () => { fireEvent.keyDown(field(), { key: "Enter" }); });
    expect(onSend).toHaveBeenCalledWith("👻".repeat(4_096));
  });

  it("off the live link, past 16 KiB the hard count shows instead of the DHT's", () => {
    composer({ softBytes: 256 });
    fireEvent.change(field(), { target: { value: "x".repeat(300) } });
    expect(screen.getByTestId("dht-byte-count")).toHaveTextContent("300 / 256 B");
    fireEvent.change(field(), { target: { value: "é".repeat(8_200) } });
    expect(screen.queryByTestId("dht-byte-count")).toBeNull();
    expect(screen.getByTestId("composer-left")).toHaveTextContent("-16 B");
  });
});
