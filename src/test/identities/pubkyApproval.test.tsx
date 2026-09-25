import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, newIdentityBinding, pubkyProofPath } from "@ghostly/core";
import { AddIdentityDialog } from "../../components/identities/AddIdentityDialog";
import { IdentityProofsSection } from "../../components/identities/IdentityProofsSection";
import { renderApp as render } from "../render";
import { proofView } from "./views";

// covers: proofs.pubky

/**
 * Adding and removing a Pubky identity in the UI, with the Pubky SDK replaced: the approval screen shows Passport's
 * button and Ring's QR code of ONE request; the button opens Passport straight from the click (a popup opened after an
 * await is blocked); the request, which carries a relay secret, is never logged or written into the page as text.
 */

/** Looks like a real one: the relay secret is in it. */
const AUTH_URL = "pubkyauth://signin?caps=%2Fpub%2Fghostly.app%2Fproofs%2Fx%2F%3Aw&relay=https%3A%2F%2Fhttprelay.pubky.app%2Finbox&secret=c2VjcmV0LXJlbGF5LWtleQ";
const PASSPORT = `https://passport.pubky.app/authorize#d=${encodeURIComponent(AUTH_URL)}`;
const key = createIdentity().pubKeyZ32;

const sdk = vi.hoisted(() => ({
  capabilities: [] as string[],
  approve: undefined as undefined | ((session: unknown) => void),
  written: [] as [string, string][],
  deleted: [] as string[],
}));

vi.mock("@synonymdev/pubky", () => ({
  AuthFlowKind: { signin: () => "signin" },
  GrantAuthFlow: {
    start(capabilities: string) {
      sdk.capabilities.push(capabilities);
      let arrived: unknown;
      sdk.approve = session => { arrived = session; };
      return { authorizationUrl: AUTH_URL, tryPollOnce: async () => arrived, free: () => {} };
    },
  },
}));

/** What Ring or Passport hands back: a session for this key, granted exactly what was asked. */
function session() {
  const granted = sdk.capabilities[sdk.capabilities.length - 1];
  return {
    info: { publicKey: { z32: () => key, free: () => {} }, capabilities: [granted], free: () => {} },
    storage: {
      putText: async (path: string, text: string) => { sdk.written.push([path, text]); },
      delete: async (path: string) => { sdk.deleted.push(path); },
    },
    signout: async () => {}, free: () => {},
  };
}

const renderApp = (...args: Parameters<typeof render>) => { const shown = render(...args); document.documentElement.dataset.reduceMotion = "true"; return shown; };

describe("Pubky approval in the UI", () => {
  const logged: unknown[] = [];
  let popup: { closed: boolean; close: ReturnType<typeof vi.fn> };
  let open: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    Object.assign(sdk, { capabilities: [], approve: undefined, written: [], deleted: [] });
    logged.length = 0;
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args) => { logged.push(args); });
    popup = { closed: false, close: vi.fn(() => { popup.closed = true; }) };
    open = vi.fn(() => popup);
    vi.spyOn(window, "open").mockImplementation(open as unknown as typeof window.open);
  });
  afterEach(() => {
    const text = JSON.stringify(logged.map(args => (args as unknown[]).map(String)));
    expect(text).not.toContain("pubkyauth");
    expect(text).not.toContain("c2VjcmV0");
  });

  it("adds one: Passport's button opens the popup synchronously in the click, Ring's QR code is the same request", async () => {
    const onClose = vi.fn();
    const { user, engine } = renderApp(<AddIdentityDialog onClose={onClose} />);
    engine.on("beginIdentityProof", ({ provider, subject, validityDays = 90 }) =>
      ({ draftId: "draft-1", binding: newIdentityBinding({ provider, subject, validitySeconds: validityDays * 86_400 }).binding }));
    engine.on("completeIdentityProof", () => proofView({ provider: "pubky", subject: key }));

    await user.click(screen.getByTestId("add-identity-pubky"));
    expect(screen.getByTestId("add-identity-start")).toHaveTextContent("Continue");
    await user.click(screen.getByTestId("add-identity-start"));
    const approval = await screen.findByTestId("approval");
    // One request, for one proof folder.
    expect(sdk.capabilities).toEqual([expect.stringMatching(/^\/pub\/ghostly\.app\/proofs\/[a-f0-9]{64}\/:w$/)]);
    const button = within(approval).getByTestId("approval-open");
    expect(button).toHaveTextContent("Approve in your browser (Pubky Passport)");
    expect(within(approval).getByRole("img", { name: "Or scan with Pubky Ring" })).toBeInTheDocument();
    expect(approval).toHaveTextContent("Continue with Google");
    expect(approval).toHaveTextContent("recovered with Google plus Passport");
    // The request is drawn in the QR code, never written in the page.
    expect(document.body.innerHTML).not.toContain("pubkyauth");
    expect(document.body.innerHTML).not.toContain("c2VjcmV0");

    // A synchronous dispatch: if anything were awaited before window.open, it would not have been called yet.
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe(PASSPORT);
    expect(open.mock.calls[0][2]).toMatch(/popup/);
    expect(open.mock.calls[0][2]).not.toMatch(/noopener|noreferrer/);

    // Approved (in Passport or Ring alike): the screen goes, the popup is closed, the proof is written and checked.
    await act(async () => { sdk.approve!(session()); });
    // The request is polled every second.
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(screen.queryByTestId("approval")).not.toBeInTheDocument();
    expect(popup.close).toHaveBeenCalled();
    const [call] = engine.callsTo("beginIdentityProof");
    expect(call).toMatchObject({ provider: "pubky", subject: key });
    const [complete] = engine.callsTo("completeIdentityProof") as unknown as [{ evidence: { folder: string } }];
    expect(sdk.written).toHaveLength(1);
    expect(sdk.written[0][0]).toMatch(new RegExp(`^/pub/ghostly\\.app/proofs/${complete.evidence.folder}/[a-f0-9]{64}\\.txt$`));
    expect(sdk.written[0][1]).toMatch(new RegExp(`^Ghostly identity proof v1: I control pubky:${key} `));
  });

  it("cancelling the approval saves nothing and says so", async () => {
    const { user, engine } = renderApp(<AddIdentityDialog onClose={() => {}} />);
    await user.click(screen.getByTestId("add-identity-pubky"));
    await user.click(screen.getByTestId("add-identity-start"));
    await user.click(await screen.findByTestId("approval-cancel"));
    expect(screen.queryByTestId("approval")).not.toBeInTheDocument();
    expect(screen.getByTestId("add-identity-error")).toHaveTextContent("Cancelled. Nothing was saved.");
    expect(engine.callsTo("beginIdentityProof")).toEqual([]);
    expect(open).not.toHaveBeenCalled();
  });

  it("removes one: says what removal needs, asks again for the same folder and deletes the file, then revokes", async () => {
    const folder = "a".repeat(64);
    const id = "b".repeat(64);
    const { user, engine } = renderApp(<IdentityProofsSection />);
    engine.on("removeIdentityProof", () => undefined);
    act(() => engine.update({ identityProofs: [proofView({ id, provider: "pubky", subject: key, verified: { subject: key, source: "File on the homeserver hs.example.com" }, evidence: { folder } })] }));
    await user.click(screen.getByTestId("identity-proof"));
    await user.click(screen.getByTestId("identity-proof-remove"));
    const notes = screen.getByTestId("identity-proof-remove-notes");
    expect(notes).toHaveTextContent("deleting it takes one more approval in Pubky Ring or Passport: Ghostly kept no access to it");
    expect(screen.getByTestId("identity-proof-remove-confirm")).toHaveTextContent("Remove, keep the file");

    await user.click(screen.getByTestId("identity-proof-remove-unpublish"));
    const approval = await within(notes).findByTestId("approval");
    expect(sdk.capabilities).toEqual([`/pub/ghostly.app/proofs/${folder}/:w`]);
    // Nothing removed until it is approved, and the card does not say it is revoking while it waits.
    expect(engine.callsTo("removeIdentityProof")).toEqual([]);
    expect(screen.getByTestId("identity-proof")).not.toHaveTextContent("Revoking");
    fireEvent.click(within(approval).getByTestId("approval-open"));
    expect(open).toHaveBeenCalledWith(PASSPORT, "pubky-passport", expect.stringMatching(/popup/));

    await act(async () => { sdk.approve!(session()); });
    await vi.waitFor(() => expect(engine.callsTo("removeIdentityProof")).toEqual([{ id }]), { timeout: 5_000 });
    expect(sdk.deleted).toEqual([pubkyProofPath(folder, id)]);
    expect(sdk.written).toEqual([]);
  });

  it("removes one without the file when asked: no approval, the revocation only", async () => {
    const { user, engine } = renderApp(<IdentityProofsSection />);
    engine.on("removeIdentityProof", () => undefined);
    act(() => engine.update({ identityProofs: [proofView({ id: "c".repeat(64), provider: "pubky", subject: key, verified: { subject: key, source: "File" }, evidence: { folder: "d".repeat(64) } })] }));
    await user.click(screen.getByTestId("identity-proof"));
    await user.click(screen.getByTestId("identity-proof-remove"));
    await user.click(screen.getByTestId("identity-proof-remove-confirm"));
    expect(engine.callsTo("removeIdentityProof")).toEqual([{ id: "c".repeat(64) }]);
    expect(sdk.capabilities).toEqual([]);
  });
});
