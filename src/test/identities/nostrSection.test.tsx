import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NostrSocialSettings } from "@ghostly/browser/nostr/types";
import { NostrSection } from "../../components/nostr/NostrSection";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: nostr.social.profile, nostr.social.publish

const DEFAULTS = "wss://relay.damus.io\nwss://nos.lol";
const TEST_RELAY = "wss://relay.ghostly.test";
const nostr = (settings: Partial<NostrSocialSettings> = {}) => ({ own: [], settings: { relays: DEFAULTS.split("\n"), autoLoadProfiles: false, publish: false, ...settings } });
/** The engine telling the page again what it already said, as it does after any change elsewhere (a proof, a chat, the wallet). */
const pushAgain = (settings: Partial<NostrSocialSettings> = {}) => act(() => fakeEngine.update({ nostr: nostr(settings) }));

describe("Identities → Nostr relays", () => {
  it("keeps what the person typed when the engine pushes a state in the meantime", async () => {
    const { user } = renderApp(<NostrSection />);
    act(() => fakeEngine.update({ nostr: nostr() }));
    const relays = screen.getByTestId("nostr-relays");
    expect(relays).toHaveValue(DEFAULTS);

    await user.clear(relays);
    await user.type(relays, TEST_RELAY);
    pushAgain();
    expect(relays).toHaveValue(TEST_RELAY);
    expect(screen.getByTestId("nostr-relays-save")).toBeEnabled();
  });

  it("a state made before the save answered does not put the old list back; the saved one replaces the draft", async () => {
    const { user } = renderApp(<NostrSection />);
    act(() => fakeEngine.update({ nostr: nostr() }));
    let answer!: () => void;
    fakeEngine.on("updateSettings", () => new Promise<void>(resolve => { answer = resolve; }));
    const relays = screen.getByTestId("nostr-relays");
    await user.clear(relays);
    await user.type(relays, TEST_RELAY);
    await user.click(screen.getByTestId("nostr-relays-save"));
    expect(fakeEngine.callsTo("updateSettings")).toEqual([{ settings: { nostr: { relays: [TEST_RELAY] } } }]);

    // Still the old list in the engine's state: the save is in flight.
    pushAgain();
    expect(relays).toHaveValue(TEST_RELAY);
    await act(async () => answer());
    expect(relays).toHaveValue(TEST_RELAY);

    pushAgain({ relays: [TEST_RELAY] });
    expect(relays).toHaveValue(TEST_RELAY);
    expect(screen.getByTestId("nostr-relays-save")).toBeDisabled();
    // The draft is gone: the field follows the engine again.
    pushAgain({ relays: ["wss://nos.lol"] });
    expect(relays).toHaveValue("wss://nos.lol");
  });

  it("a refused save keeps what was typed and says why", async () => {
    const { user } = renderApp(<NostrSection />);
    act(() => fakeEngine.update({ nostr: nostr() }));
    fakeEngine.on("updateSettings", () => { throw new Error("Not a relay address: ftp://x"); });
    const relays = screen.getByTestId("nostr-relays");
    await user.clear(relays);
    await user.type(relays, "ftp://x");
    await user.click(screen.getByTestId("nostr-relays-save"));
    expect(await screen.findByTestId("nostr-section-error")).toHaveTextContent("Not a relay address");
    pushAgain();
    expect(relays).toHaveValue("ftp://x");
  });

  it("a switch sends only itself, so it cannot put back relays from a state the page has not updated yet", async () => {
    const { user } = renderApp(<NostrSection />);
    act(() => fakeEngine.update({ nostr: nostr() }));
    fakeEngine.on("updateSettings", () => undefined);
    await user.click(screen.getByTestId("nostr-publish"));
    await user.click(screen.getByTestId("nostr-auto-load"));
    expect(fakeEngine.callsTo("updateSettings")).toEqual([{ settings: { nostr: { publish: true } } }, { settings: { nostr: { autoLoadProfiles: true } } }]);
  });
});
