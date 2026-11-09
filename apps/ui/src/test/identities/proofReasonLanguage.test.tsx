import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { IdentityTimelineEntry } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { IdentityShareLine } from "../../components/identities/IdentityShareLine";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { identitiesView, receivedView } from "./views";

// covers: proofs.timeline, proofs.recheck

/*
 * Why a contact's proof failed this app's check (the first check, or the daily re-check) is the provider's own English
 * (packages/browser/src/proofs/**, core identityProofs.ts). It showed as it came under the share in the chat and on the
 * back of the contact's card, in every language: a GitHub account renamed, an AT Protocol record deleted, a Pubky file
 * gone. Said in the app's language now, and a reason the app does not know is a translated line, never the English.
 */

const entry = (error: string): IdentityTimelineEntry =>
  ({ id: "theirs:received-1:0", proof: "received-1", side: "theirs", kind: "shared", provider: "ssh-github", subject: "octocat-old", state: "failed", error, at: Date.now() - 1000 });
const paired = (patch: Partial<LinkView> = {}) => linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView(), ...patch });

function shareReason(error: string, language: "pt" | "ar") {
  const view = renderApp(<IdentityShareLine entry={entry(error)} link={undefined} contact="Alice" onOpen={vi.fn()} />, { language });
  const reason = screen.getByTestId("identity-share-reason");
  const text = reason.textContent;
  view.unmount();
  return text;
}

/** [reason as the check threw it, how it reads in Portuguese, how it reads in Arabic]. */
const REASONS: readonly (readonly [string, string, string])[] = [
  ["GitHub has no account octocat-old", "O GitHub não tem a conta octocat-old. Ela foi renomeada ou apagada.", "لا يوجد في GitHub حساب باسم octocat-old. غُيّر اسمه أو حُذف."],
  ["GitLab has no account someone", "O GitLab não tem a conta someone. Ela foi renomeada ou apagada.", "لا يوجد في GitLab حساب باسم someone. غُيّر اسمه أو حُذف."],
  ["The record is no longer in the account's repository", "O registro da prova não está mais na conta", "لم يعد سجل الإثبات موجودًا في الحساب"],
  ["The account is no longer on its server", "A conta não está mais no servidor dela", "لم يعد الحساب موجودًا على خادمه"],
  ["The proof file is not on the homeserver", "O arquivo da prova não está no homeserver", "ملف الإثبات غير موجود على الخادم المنزلي"],
  ["Its owner revoked this proof", "O dono revogou esta prova", "ألغى مالكه هذا الإثبات"],
  ["The proof has expired", "A prova expirou", "انتهت صلاحية الإثبات"],
];

describe("why a contact's proof failed this app's check, in the app's language", () => {
  it.each(REASONS)("%s: under the share in the chat, in Portuguese and Arabic", (raw, pt, ar) => {
    expect(shareReason(raw, "pt")).toBe(pt);
    expect(shareReason(raw, "ar")).toBe(ar);
  });

  it("a reason the app does not know is a translated line, never the English", () => {
    const raw = "The Nostr event id does not match its content";
    expect(shareReason(raw, "pt")).toBe("Não foi possível verificar esta prova");
    expect(shareReason(raw, "ar")).toBe("تعذّر التحقق من هذا الإثبات");
  });

  it("on the back of the contact's card, a GitHub account gone reads in Portuguese", async () => {
    const { user, engine } = renderApp(<ContactIdentitiesPanel peerKey="peer" name="Alice" onClose={vi.fn()} />, { language: "pt" });
    document.documentElement.dataset.reduceMotion = "true";
    const received = receivedView({ id: "r1", provider: "ssh-github", subject: "octocat-old", status: "unconfirmed", error: "GitHub has no account octocat-old", verified: { subject: "octocat-old", source: "GitHub: octocat-old (via published SSH key)" } });
    act(() => engine.update({ links: [paired({ identities: identitiesView({ received: [received] }) })] }));
    await user.click(within(screen.getByTestId("chat-identities-received")).getAllByTestId("chat-identity-received")[0]!);
    const status = within(screen.getByTestId("chat-identity-back")).getByTestId("chat-identity-received-status");
    expect(status).toHaveTextContent("O GitHub não tem a conta octocat-old. Ela foi renomeada ou apagada.");
    expect(status).not.toHaveTextContent(/has no account/);
  });
});
