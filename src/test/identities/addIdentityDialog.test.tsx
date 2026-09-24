import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newIdentityBinding } from "@ghostly/core";
import type { BrowserHost } from "@ghostly/browser/host";
import { OIDC_PROVIDERS } from "@ghostly/browser/proofs/oidc/providers";
import { IDENTITY_PROVIDERS } from "@ghostly/browser/proofs/registry";
import { AddIdentityDialog } from "../../components/identities/AddIdentityDialog";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { proofView } from "./views";

// covers: proofs.picker, proofs.domain.dns, proofs.ssh, proofs.oidc


const provider = (id: string) => IDENTITY_PROVIDERS.find((p) => p.id === id)!;
/** What a web page can add with no OpenID Connect client IDs in the build (they await registration). */
const WITHOUT_OIDC = IDENTITY_PROVIDERS.filter((p) => p.id !== "oidc");

function dialog() {
  const onClose = vi.fn();
  return { onClose, ...renderApp(<AddIdentityDialog onClose={onClose} />) };
}

/** The engine's answer to "begin": a real binding for the subject as the provider normalizes it, as the engine does. */
function answerBegin() {
  fakeEngine.on("beginIdentityProof", ({ provider: id, subject, validityDays = 30 }) =>
    ({ draftId: "draft-1", binding: newIdentityBinding({ provider: id, subject: provider(id).subject.normalize(subject), validitySeconds: validityDays * 86400 }).binding }));
}

/**
 * A build with Google and Microsoft client IDs, on a platform that can open their sign-in window: what
 * "Account at a provider" needs to be offered.
 */
function configureOidc() {
  const saved = { google: OIDC_PROVIDERS.google.clientIds, microsoft: OIDC_PROVIDERS.microsoft.clientIds };
  OIDC_PROVIDERS.google.clientIds = { web: "google-client" };
  OIDC_PROVIDERS.microsoft.clientIds = { web: "microsoft-client" };
  (fakeEngine as BrowserHost).oidc = { platform: "web", open: () => new Promise(() => {}) };
  return () => { Object.assign(OIDC_PROVIDERS.google, { clientIds: saved.google }); Object.assign(OIDC_PROVIDERS.microsoft, { clientIds: saved.microsoft }); delete (fakeEngine as BrowserHost).oidc; };
}

/** Identities → Add an identity. */
describe("AddIdentityDialog", () => {
  let restore: (() => void) | undefined;
  afterEach(() => { restore?.(); restore = undefined; });

  describe("the picker", () => {
    it("shows one card per provider that can be added here, in registry order", () => {
      dialog();
      const cards = within(screen.getByRole("list", { name: "Kinds of identity" })).getAllByRole("listitem");
      expect(cards.map((c) => c.dataset.testid)).toEqual(WITHOUT_OIDC.map((p) => `add-identity-card-${p.id}`));
    });

    it("has a card for every registered provider once each can be added", () => {
      restore = configureOidc();
      dialog();
      for (const p of IDENTITY_PROVIDERS) expect(screen.getByTestId(`add-identity-card-${p.id}`)).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(IDENTITY_PROVIDERS.length);
    });

    it.each(WITHOUT_OIDC.map((p) => [p.id, p] as const))("%s: the card shows its name, category and one line, not the long description", (id, p) => {
      dialog();
      const card = screen.getByTestId(`add-identity-card-${id}`);
      expect(within(card).getByTestId("add-identity-summary")).toHaveTextContent(p.summary);
      expect(card).toHaveTextContent(p.label);
      expect(card).toHaveTextContent(p.category === "provider-attested" ? "Attested by a provider" : "Your own key");
      expect(card).not.toHaveTextContent(p.description);
      if (p.limits) expect(card).not.toHaveTextContent(p.limits);
      expect(screen.getByTestId(`add-identity-about-${id}`)).toHaveAttribute("aria-expanded", "false");
    });

    it.each(WITHOUT_OIDC.map((p) => [p.id, p] as const))("%s: About opens the details in place, with the caveats it declares", async (id, p) => {
      const { user } = dialog();
      const about = screen.getByRole("button", { name: `About ${p.label}` });
      await user.click(about);
      expect(about).toHaveAttribute("aria-expanded", "true");
      const details = document.getElementById(about.getAttribute("aria-controls")!)!;
      expect(screen.getByTestId(`add-identity-card-${id}`)).toContainElement(details);
      expect(details).toHaveTextContent(p.description);
      if (p.limits) expect(within(details).getByTestId("identity-about-limits")).toHaveTextContent(p.limits);
      else expect(within(details).queryByTestId("identity-about-limits")).not.toBeInTheDocument();
      expect(details).toHaveTextContent(p.category === "provider-attested" ? "A company vouches" : "Only the holder of this key can make this proof.");
      // Reading is not adding: still the picker.
      expect(screen.getByRole("list", { name: "Kinds of identity" })).toBeInTheDocument();
      await user.click(about);
      expect(about).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByTestId(`add-identity-card-${id}`)).not.toHaveTextContent(p.description);
    });

    it("keeps one card's details open at a time", async () => {
      const { user } = dialog();
      await user.click(screen.getByTestId("add-identity-about-bitcoin"));
      await user.click(screen.getByTestId("add-identity-about-domain"));
      expect(screen.getByTestId("add-identity-about-bitcoin")).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByTestId("add-identity-about-domain")).toHaveAttribute("aria-expanded", "true");
      expect(screen.getAllByTestId("identity-about")).toHaveLength(1);
    });

    it("shows the attested caveat on the OpenID Connect card, with a mark per configured provider", async () => {
      restore = configureOidc();
      const { user } = dialog();
      const card = screen.getByTestId("add-identity-card-oidc");
      expect(card).toHaveTextContent("Attested by a provider");
      expect([...card.querySelectorAll("[data-icon]")].map((e) => e.getAttribute("data-icon"))).toEqual(["oidc", "oidc:google", "oidc:microsoft"]);
      await user.click(screen.getByTestId("add-identity-about-oidc"));
      expect(within(card).getByTestId("identity-about-limits")).toHaveTextContent(provider("oidc").limits!);
      expect(card).toHaveTextContent("A company vouches that you logged in to this account. Your contacts see who vouches.");
    });

    it("closes from its close button and from Escape", async () => {
      const { user, onClose } = dialog();
      await user.click(screen.getByRole("button", { name: "Close" }));
      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(2);
    });
  });

  describe("a chosen provider", () => {
    it("shows its details above the form, and Back returns to the picker", async () => {
      const { user } = dialog();
      await user.click(screen.getByTestId("add-identity-bitcoin"));
      expect(screen.queryByRole("list", { name: "Kinds of identity" })).not.toBeInTheDocument();
      const about = screen.getByTestId("add-identity-about");
      expect(about).toHaveTextContent(provider("bitcoin").description);
      expect(within(about).getByTestId("identity-about-limits")).toHaveTextContent("It does not prove a balance, a past payment, or that you would pay.");
      expect(screen.getByText(provider("bitcoin").privacy, { exact: false })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Back" }));
      expect(screen.getByRole("list", { name: "Kinds of identity" })).toBeInTheDocument();
    });

    it("offers the validity periods up to the provider's maximum, starting on its default", async () => {
      const { user } = dialog();
      await user.click(screen.getByTestId("add-identity-domain"));
      const validity = screen.getByTestId("add-identity-validity");
      expect(within(validity).getAllByRole("option").map((o) => o.textContent)).toEqual(["7 days", "30 days", "90 days", "180 days", "365 days"]);
      expect(validity).toHaveValue("90");
    });

    it("needs the subject before it continues, and asks the engine to begin with what was chosen", async () => {
      const { user, engine } = dialog();
      engine.on("beginIdentityProof", () => { throw new Error("Ghostly is offline"); });
      await user.click(screen.getByTestId("add-identity-domain"));
      // The signers that work here; the NIP-07 one needs a browser extension this page does not have.
      expect(within(screen.getByTestId("add-identity-signer")).getAllByRole("option").map((o) => o.textContent)).toEqual(["DNS TXT record", "File on your website", "NIP-05 with a remote signer"]);
      const start = screen.getByTestId("add-identity-start");
      expect(start).toHaveTextContent("Continue");
      expect(start).toBeDisabled();
      await user.type(screen.getByTestId("add-identity-subject"), "example.com");
      await user.selectOptions(screen.getByTestId("add-identity-validity"), "30");
      await user.click(start);
      expect(engine.callsTo("beginIdentityProof")).toEqual([{ provider: "domain", subject: "example.com", validityDays: 30 }]);
      expect(await screen.findByTestId("add-identity-error")).toHaveTextContent("Ghostly is offline");
    });

    it("asks for an in-app signer's fields instead of a subject, secrets as password inputs", async () => {
      const { user } = dialog();
      await user.click(screen.getByTestId("add-identity-nostr"));
      // Only the remote signer: no NIP-07 extension in this page, so no choice to make.
      expect(screen.queryByTestId("add-identity-signer")).not.toBeInTheDocument();
      expect(screen.getByText("Paste the bunker:// link from your signer app, then approve there.")).toBeInTheDocument();
      expect(screen.queryByTestId("add-identity-subject")).not.toBeInTheDocument();
      const link = screen.getByTestId("add-identity-field-bunker");
      expect(link).toHaveAttribute("type", "password");
      const start = screen.getByTestId("add-identity-start");
      expect(start).toHaveTextContent("Sign with Remote signer");
      expect(start).toBeDisabled();
      await user.type(link, "bunker://abc");
      expect(start).toBeEnabled();
    });

    it("switches between a publish signer and an in-app one", async () => {
      const { user } = dialog();
      await user.click(screen.getByTestId("add-identity-domain"));
      await user.selectOptions(screen.getByTestId("add-identity-signer"), "nip05-nip46");
      expect(screen.queryByTestId("add-identity-subject")).not.toBeInTheDocument();
      expect(screen.getByTestId("add-identity-field-domain")).toHaveAttribute("type", "text");
      expect(screen.getByTestId("add-identity-field-bunker")).toHaveAttribute("type", "password");
      expect(screen.getByTestId("add-identity-start")).toHaveTextContent("Sign with NIP-05 with a remote signer");
    });
  });

  describe("OpenID Connect providers", () => {
    it("are a radio group, the first chosen, one checked at a time", async () => {
      restore = configureOidc();
      const { user } = dialog();
      await user.click(screen.getByTestId("add-identity-oidc"));
      const group = screen.getByRole("radiogroup", { name: "Provider" });
      const [google, microsoft] = within(group).getAllByRole("radio");
      expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["Google", "Microsoft"]);
      expect(google).toHaveAttribute("aria-checked", "true");
      expect(microsoft).toHaveAttribute("aria-checked", "false");
      await user.click(microsoft);
      expect(google).toHaveAttribute("aria-checked", "false");
      expect(microsoft).toHaveAttribute("aria-checked", "true");
      expect(group).toHaveAttribute("data-value", "https://login.microsoftonline.com/{tenantid}/v2.0");
    });

    it("keep proofs short-lived and begin with the chosen issuer", async () => {
      restore = configureOidc();
      const { user, engine } = dialog();
      answerBegin();
      await user.click(screen.getByTestId("add-identity-oidc"));
      expect(within(screen.getByTestId("add-identity-validity")).getAllByRole("option").map((o) => o.textContent)).toEqual(["7 days"]);
      expect(within(screen.getByTestId("add-identity-signer")).getAllByRole("option")).toHaveLength(3);
      await user.click(screen.getByRole("radio", { name: "Google" }));
      await user.click(screen.getByTestId("add-identity-start"));
      expect(engine.callsTo("beginIdentityProof")).toEqual([{ provider: "oidc", subject: "https://accounts.google.com", validityDays: 7 }]);
      // The popup opens from the next click, which keeps the browser's user activation.
      expect(await screen.findByTestId("add-identity-finish")).toHaveTextContent("Continue with Account at a provider");
      expect(screen.getByText(/your password never reaches Ghostly/)).toBeInTheDocument();
    });
  });

  describe("finishing", () => {
    it("shows what to publish, checks it and saves (DNS)", async () => {
      const { user, engine, onClose } = dialog();
      answerBegin();
      engine.on("completeIdentityProof", () => proofView());
      await user.click(screen.getByTestId("add-identity-domain"));
      await user.type(screen.getByTestId("add-identity-subject"), "example.com");
      await user.click(screen.getByTestId("add-identity-start"));
      expect(await screen.findByTestId("add-identity-copy-0")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Check and save" }));
      expect(engine.callsTo("completeIdentityProof")).toEqual([{ draftId: "draft-1", evidence: expect.anything() }]);
      expect(onClose).toHaveBeenCalledOnce();
      // Completed: nothing to cancel.
      expect(engine.callsTo("cancelIdentityProof")).toEqual([]);
    });

    it("cancels the engine's draft when closed before finishing", async () => {
      const { user, engine, onClose } = dialog();
      answerBegin();
      engine.on("cancelIdentityProof", () => undefined);
      await user.click(screen.getByTestId("add-identity-domain"));
      await user.type(screen.getByTestId("add-identity-subject"), "example.com");
      await user.click(screen.getByTestId("add-identity-start"));
      await user.click(await screen.findByRole("button", { name: "Cancel" }));
      expect(engine.callsTo("cancelIdentityProof")).toEqual([{ draftId: "draft-1" }]);
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("needs a pasted signature from an external tool, and says when it is not one", async () => {
      const { user, engine } = dialog();
      answerBegin();
      await user.click(screen.getByTestId("add-identity-ssh"));
      await user.type(screen.getByTestId("add-identity-subject"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl");
      await user.click(screen.getByTestId("add-identity-start"));
      const finish = await screen.findByTestId("add-identity-finish");
      expect(finish).toHaveTextContent("Verify and save");
      expect(finish).toBeDisabled();
      await user.type(screen.getByTestId("add-identity-paste"), "not a signature");
      await user.click(finish);
      expect(await screen.findByTestId("add-identity-error")).toHaveTextContent("Paste the whole signature, from -----BEGIN SSH SIGNATURE----- to -----END SSH SIGNATURE-----");
      // Refused in the page: nothing reached the engine.
      expect(engine.callsTo("completeIdentityProof")).toEqual([]);
    });
  });
});
