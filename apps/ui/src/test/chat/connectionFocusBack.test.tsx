import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: transport.chat-switch

type Pairing = NonNullable<LinkView["pairing"]>;
const all = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];

/**
 * What a real browser does to a focused control that turns disabled: the page gets the focus. happy-dom keeps it on
 * the control, and its `blur()` does nothing on a disabled one, so the control reads as enabled for that one call.
 */
function dropFocusIfDisabled() {
  const el = document.activeElement as HTMLButtonElement | null;
  if (!el || !(el.disabled || el.closest("fieldset[disabled]"))) return;
  Object.defineProperty(el, "disabled", { value: false, configurable: true });
  el.blur();
  delete (el as Partial<HTMLButtonElement>).disabled;
}

/** An engine call held open until `done()`: the panel stays busy meanwhile. */
function held(engine: ReturnType<typeof renderApp>["engine"], method: "setChatTransport" | "confirmPair", fail?: string) {
  let done!: () => void;
  engine.on(method, () => new Promise<void>((resolve, reject) => { done = () => fail ? reject(new Error(fail)) : resolve(); }));
  return () => act(async () => { done(); });
}

/**
 * The panel disables its choices and buttons while the engine works on one, and a browser drops the focus of a
 * disabled control to the page: the next Tab left the panel, and its Escape did not close it. Once the work is done,
 * the focus is back on what was pressed.
 */
describe("the connection panel, while a choice or button works", () => {
  it("gives the focus back to the transport chosen from the keyboard", async () => {
    const { user, engine } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [linkView({ availableTransports: all, transportAutomatic: false, preferredTransport: "webrtc/1", pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open" })] }));
    const finish = held(engine, "setChatTransport");
    await user.click(screen.getByTestId("connection-options"));
    screen.getByTestId("connection-option-webrtc").focus();
    await user.keyboard("{End}");
    const dht = screen.getByTestId("connection-option-dht");
    expect(dht).toHaveFocus();
    await user.keyboard(" ");
    expect(engine.callsTo("setChatTransport")).toEqual([{ linkId: "link-1", transport: "dht" }]);
    expect(dht).toBeDisabled();
    dropFocusIfDisabled();
    expect(document.body).toHaveFocus();
    await finish();
    expect(dht).not.toBeDisabled();
    expect(dht).toHaveFocus();
  });

  it("gives the focus back to The codes match when the engine refuses it", async () => {
    const { user, engine } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [linkView({ availableTransports: all, peerParticipationKey: "saved", pairing: { status: "ready", transport: "webrtc/1", code: "4821 0937", peerKey: "peer" } as Pairing })] }));
    const finish = held(engine, "confirmPair", "No authenticated peer to verify");
    await user.click(screen.getByTestId("connection-options"));
    await user.click(screen.getByTestId("pair-verify"));
    const confirm = screen.getByTestId("pair-verify-confirm");
    confirm.focus();
    await user.keyboard("{Enter}");
    expect(confirm).toBeDisabled();
    dropFocusIfDisabled();
    expect(document.body).toHaveFocus();
    await finish();
    expect(screen.getByTestId("pair-verify-error")).toBeInTheDocument();
    expect(confirm).toHaveFocus();
  });

  it("leaves the focus where the person moved it meanwhile", async () => {
    const { user, engine } = renderApp(<ChatConnection peerKey="peer" />);
    act(() => engine.update({ links: [linkView({ availableTransports: all, transportAutomatic: false, preferredTransport: "webrtc/1", pairing: { status: "ready", transport: "webrtc/1" } as Pairing, dataLink: "open" })] }));
    const finish = held(engine, "setChatTransport");
    await user.click(screen.getByTestId("connection-options"));
    screen.getByTestId("connection-option-dht").focus();
    await user.keyboard(" ");
    dropFocusIfDisabled();
    const details = screen.getByTestId("connection-details-summary");
    details.focus();
    await finish();
    expect(details).toHaveFocus();
  });
});
