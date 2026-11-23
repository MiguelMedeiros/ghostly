import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { renderApp } from "../render";

// covers: app.composer.paste-files, files.paired.send

/*
 * A file's name reaches the contact as a message's text does: a name that looks like a secret asks first, as the
 * draft and the CLI's `file send` do (SecretGuardDialog), and the file goes only on "Send anyway".
 */

/** Key 0x0101…01: it has never held anything. */
const NSEC = "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw";

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File) => Promise<string | null>>();
const composer = () => renderApp(<LockScreenProvider><div data-file-drop><MessageInput onSend={onSend} onSendFile={onSendFile} /></div></LockScreenProvider>);
const text = (name: string) => new File(["k"], name, { type: "text/plain" });
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
const paste = (files: File[]) => fireEvent.paste(field(), { clipboardData: {
  files, types: ["Files"], items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })), getData: () => "", dropEffect: "none",
} });

beforeEach(() => {
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
});

describe("the secret guard on a file's name", () => {
  it("a picked file named with a Nostr key asks first: Cancel sends nothing, Send anyway sends it", async () => {
    const { user } = composer();
    const input = screen.getByTestId<HTMLInputElement>("file-input");
    // A `:` the name loses on the way (sanitizeFileName) does not hide the key.
    await user.upload(input, [text("ok.txt"), text(`${NSEC.slice(0, 30)}:${NSEC.slice(30)}.txt`)]);
    expect(await screen.findByTestId("secret-guard")).toHaveAttribute("data-kind", "nsec");
    expect(onSendFile).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(screen.queryByTestId("secret-guard")).not.toBeInTheDocument();
    expect(onSendFile).not.toHaveBeenCalled();
    await user.upload(input, [text(`${NSEC}.txt`)]);
    await user.click(await screen.findByTestId("secret-guard-send"));
    await waitFor(() => expect(onSendFile.mock.calls.map(([f]) => f.name)).toEqual([`${NSEC}.txt`]));
  });

  it("a pasted file named with a key asks before the sheet sends it; Cancel keeps the sheet and its caption", async () => {
    const { user } = composer();
    paste([text(`${NSEC}.txt`)]);
    await user.type(await screen.findByTestId("attachment-caption"), "look");
    await user.click(screen.getByTestId("attachment-send"));
    expect(await screen.findByTestId("secret-guard")).toHaveAttribute("data-kind", "nsec");
    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(onSendFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("attachment-caption")).toHaveValue("look");
    await user.click(screen.getByTestId("attachment-send"));
    await user.click(await screen.findByTestId("secret-guard-send"));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("look"));
    expect(onSendFile).toHaveBeenCalledTimes(1);
  });

  it("a file whose name is no secret goes at once", async () => {
    const { user } = composer();
    await user.upload(screen.getByTestId<HTMLInputElement>("file-input"), [text("notes.txt")]);
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("secret-guard")).not.toBeInTheDocument();
  });
});
