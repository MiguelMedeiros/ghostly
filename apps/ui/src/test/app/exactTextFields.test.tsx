import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AddIdentityDialog } from "../../components/identities/AddIdentityDialog";
import { NetworkSettings } from "../../components/NetworkSettings";
import { NostrSection } from "../../components/nostr/NostrSection";
import { ProfileBackups } from "../../components/ProfileBackups";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: settings.network.relays, settings.network.turn, proofs.page, nostr.social.profile

/** What a phone's keyboard reads: no capital first letter, no corrections. */
function isExact(field: HTMLElement) {
  expect(field).toHaveAttribute("autocapitalize", "none");
  expect(field).toHaveAttribute("autocorrect", "off");
  expect(field).toHaveAttribute("spellcheck", "false");
}

describe("on a phone, the keyboard leaves these fields as typed", () => {
  it("Network's relays and TURN server", () => {
    const { engine } = renderApp(<NetworkSettings />);
    act(() => engine.update({ transport: { protocol: "Pkarr relays (HTTP) → Mainline DHT (BEP44)", relays: [] }, settings: { relays: [] } }));
    for (const id of ["network-relays", "network-hyperdht-relay", "network-push-relay"]) isExact(screen.getByTestId(id));
    isExact(screen.getByRole("textbox", { name: "TURN server URL" }));
    isExact(screen.getByRole("textbox", { name: "TURN username" }));
  });

  it("S3 backup's endpoint, bucket, access key, region and folder", async () => {
    const { user } = renderApp(<ProfileBackups canSwitch={false} />);
    await user.click(screen.getByTestId("s3-setup"));
    for (const key of ["endpoint", "bucket", "accessKeyId", "region", "prefix"]) isExact(screen.getByTestId(`s3-${key}`));
  });

  it("an identity's subject", async () => {
    const { user } = renderApp(<AddIdentityDialog onClose={() => {}} />);
    await user.click(screen.getByTestId("add-identity-bitcoin"));
    isExact(screen.getByTestId("add-identity-subject"));
  });

  it("Nostr's relays", () => {
    renderApp(<NostrSection />);
    act(() => fakeEngine.update({ nostr: { own: [], settings: { relays: [], autoLoadProfiles: false, publish: false } } }));
    isExact(screen.getByTestId("nostr-relays"));
  });
});
