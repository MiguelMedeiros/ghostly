import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { getSessionDraft, setStorageProfile as setProfile } from "../../lib/storage";
import { renderApp } from "../render";

// covers: app.composer.secret-guard

/** BIP39's test vector for entropy 0x7f repeated: it has never held anything. */
const SEED = "legal winner thank year wave sausage worth useful legal winner thank yellow";
/** A cashuB token for 8 + 13 sat on http://mint.test (test secrets, no mint behind it). */
const CASHU_21 = "cashuBo2FtcGh0dHA6Ly9taW50LnRlc3RhdWNzYXRhdIGiYWlIAJofKTJT5B5hcIKjYWEIYXNtdGVzdC1zZWNyZXQtYWFjWCECERERERERERERERERERERERERERERERERERERERERERGjYWENYXNtdGVzdC1zZWNyZXQtYmFjWCECIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI";

const onSend = vi.fn<(text: string) => Promise<string | null>>();

type Props = Partial<Parameters<typeof MessageInput>[0]>;
function composer(props: Props = {}) {
  return renderApp(<LockScreenProvider><MessageInput draftId="guard-test" onSend={onSend} identities={{ peerKey: "peer", contact: "Alice" }} {...props} /></LockScreenProvider>);
}
const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
const guard = () => screen.queryByTestId("secret-guard");

async function write(user: ReturnType<typeof composer>["user"], text: string) {
  await user.click(field());
  await user.paste(text);
}

beforeEach(() => onSend.mockReset().mockResolvedValue(null));
afterEach(() => { localStorage.clear(); setProfile(""); });

describe("the secret guard", () => {
  it("asks before a seed goes, with Cancel focused, and Cancel keeps the draft", async () => {
    const { user } = composer();
    await write(user, SEED);
    await user.keyboard("{Enter}");

    expect(guard()).toHaveAttribute("data-kind", "mnemonic");
    expect(screen.getByRole("alertdialog", { name: "Send a wallet seed?" })).toHaveAccessibleDescription(
      "This looks like a wallet seed. Anyone who sees it can take your funds. Send anyway?");
    expect(screen.getByTestId("secret-guard-cancel")).toHaveFocus();
    // It says what the text is, never the text.
    expect(guard()!.textContent).not.toContain("legal");
    expect(onSend).not.toHaveBeenCalled();

    // Enter on the focused Cancel is the default answer.
    await user.keyboard("{Enter}");
    expect(guard()).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
    expect(field()).toHaveValue(SEED);
    expect(field()).toHaveFocus();
  });

  it("the dialog's cancel (Escape) keeps the draft, and Tab stays between its two buttons", async () => {
    const { user } = composer();
    await write(user, SEED);
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(guard()).not.toBeNull();
    await user.keyboard("{Tab}");
    expect(screen.getByTestId("secret-guard-send")).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(screen.getByTestId("secret-guard-cancel")).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByTestId("secret-guard-send")).toHaveFocus();
    guard()!.dispatchEvent(new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(guard()).toBeNull());
    expect(onSend).not.toHaveBeenCalled();
    expect(field()).toHaveValue(SEED);
  });

  it("Send anyway sends the text as it was and clears the draft", async () => {
    const { user } = composer();
    await write(user, `my seed ${SEED}`);
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(`my seed ${SEED}`);
    await waitFor(() => expect(field()).toHaveValue(""));
    expect(guard()).toBeNull();
  });

  it("a send that fails after Send anyway keeps the draft, as any send does", async () => {
    onSend.mockResolvedValue("Not connected");
    const { user } = composer();
    await write(user, SEED);
    await user.keyboard("{Enter}");
    await user.click(screen.getByTestId("secret-guard-send"));
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(field()).toHaveValue(SEED);
  });

  it.each([
    ["an nsec", "nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw", "Send a Nostr private key?"],
    ["a WIF key", "KwFfNUhSDaASSAwtG7ssQM1uVX8RgX5GHWnnLfhfiQDigjioWXHH", "Send a private key?"],
    ["a hex key with its label", `private key: ${"01".repeat(32)}`, "Send a private key?"],
  ])("words the question for %s", async (_, text, title) => {
    const { user } = composer();
    await write(user, text);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog", { name: title })).toBeInTheDocument();
  });

  it("asks whether to send a Cashu token's sats to the contact, the amount read from the token", async () => {
    const { user } = composer();
    await write(user, CASHU_21);
    await user.keyboard("{Enter}");
    expect(guard()).toHaveAttribute("data-kind", "cashu");
    expect(screen.getByRole("alertdialog", { name: "Send 21 sats to Alice?" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledExactlyOnceWith(CASHU_21);
  });

  it("names the group in a group chat, \"this chat\" with no contact, and leaves out an amount it cannot read", async () => {
    const first = composer({ recipient: "Hiking club" });
    await write(first.user, CASHU_21);
    await first.user.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog", { name: "Send 21 sats to Hiking club?" })).toBeInTheDocument();
    first.unmount();

    const second = composer({ identities: undefined, draftId: "guard-test-2" });
    await write(second.user, `cashuBnotreallyatokenatallxx`);
    await second.user.keyboard("{Enter}");
    expect(screen.getByRole("alertdialog", { name: "Send this ecash to this chat?" })).toBeInTheDocument();
  });

  it("lets ordinary text, invoices and invites go at once", async () => {
    const { user } = composer();
    for (const text of ["see you at 7", "ghostly1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqgfzyvjz2f389q5j52ev95hz7vp3xgengdfkxuurjw3m8s7nu06qg9pyx3z9ger5sj22fdxy6nj02pg4y56524t9wkzetfd4ch27tasxzcnrv3jkvemgd94xkmrddehhqutjwd682anh0puh57mu04l8794pd4k",
      `txid ${"4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b"}`]) {
      await write(user, text);
      await user.keyboard("{Enter}");
      expect(guard()).toBeNull();
      expect(onSend).toHaveBeenLastCalledWith(text);
      await waitFor(() => expect(field()).toHaveValue(""));
    }
  });

  it("does not keep a seed in the stored draft; ecash stays, since the draft may be its only copy", async () => {
    const { user } = composer();
    await write(user, "hello");
    await waitFor(() => expect(getSessionDraft("guard-test")).toBe("hello"));
    await user.paste(` ${SEED}`);
    await waitFor(() => expect(getSessionDraft("guard-test")).toBe(""));
    await user.clear(field());
    await user.paste(CASHU_21);
    await waitFor(() => expect(getSessionDraft("guard-test")).toBe(CASHU_21));
  });
});
