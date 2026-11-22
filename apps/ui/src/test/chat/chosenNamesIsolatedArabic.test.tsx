import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatAppsDialog } from "../../components/apps/ChatAppsDialog";
import { ChatHoldDialog } from "../../components/ChatHoldDialog";
import { ChatServicesDialog } from "../../components/ChatServicesDialog";
import { ComposerIdentityPicker } from "../../components/identities/ComposerIdentities";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { IdentityMenuItem, IdentityStack } from "../../components/identities/ContactMarks";
import { MakeAdminDialog } from "../../components/MakeAdminDialog";
import { PeerServices } from "../../components/PeerServices";
import { RemoveMemberDialog } from "../../components/RemoveMemberDialog";
import type { PeerHoldState, PeerLinkState } from "../../lib/platform";
import { hostErrorText, serviceAppWords, serviceFraming } from "../../lib/serviceWindows";
import { translatorFor } from "../../locales";
import { fakeEngine, linkView } from "../fakeEngine";
import { identitiesView, proofView, sharedView } from "../identities/views";
import { renderApp } from "../render";

// covers: app.i18n

/*
 * The name a contact or a member chose, in the Arabic headings and lines of the chat info panel and of the dialogs a
 * person opens from a chat or a group (Remove, Make admin, Shared services, Hold, Apps, the composer's identity card):
 * each its own <bdi>, as the group call's remove questions have it. Put in plainly, a Latin name with a bracket at its
 * edge took the sentence's right-to-left direction, and "Ana (work)" read "(Ana (work" around the Arabic "؟". Where the
 * sentence is an attribute (an aria-label, which cannot hold a <bdi>), the name sits between isolate marks instead.
 */

const NAME = "Ana (work)";
/** The name between the isolate marks (U+2068 FSI, U+2069 PDI). */
const ISOLATED = `\u2068${NAME}\u2069`;
/** A contact's app, its name Latin with punctuation at its end: "Notes!" read "!Notes" in an Arabic line. */
const APP = "Notes!";
const APP_ISOLATED = `\u2068${APP}\u2069`;

/** The <bdi> holding exactly this name inside the element, if any. */
const isolated = (el: Element, name = NAME) => [...el.querySelectorAll("bdi")].some((bdi) => bdi.textContent === name);

/** A paired chat with the contact, connected now. */
const paired = (patch: Partial<LinkView> = {}) => linkView({ pairing: { status: "ready" } as LinkView["pairing"], identities: identitiesView(), ...patch });

describe("names a contact or a member chose, in Arabic, each isolated", () => {
  it("the group's Remove question", () => {
    renderApp(<RemoveMemberDialog name={NAME} onClose={vi.fn()} onConfirm={vi.fn()} />, { language: "ar" });
    const heading = within(screen.getByTestId("group-remove-dialog")).getByRole("heading");
    expect(heading).toHaveTextContent(`إزالة ${NAME}؟`);
    expect(isolated(heading)).toBe(true);
  });

  it("the group's Make admin question, its body and the link line", () => {
    renderApp(<MakeAdminDialog name={NAME} linkEnds onClose={vi.fn()} onConfirm={vi.fn()} />, { language: "ar" });
    const dialog = screen.getByTestId("group-make-admin-dialog");
    const heading = within(dialog).getByRole("heading");
    expect(heading).toHaveTextContent(`جعل ${NAME} المشرف؟`);
    expect(isolated(heading)).toBe(true);
    const body = dialog.querySelector("p")!;
    expect(body).toHaveTextContent(`بعدها لا يستطيع إلا ${NAME} إعادة تسمية المجموعة`);
    expect(body).toHaveTextContent(`يستطيع ${NAME} مشاركة رابط جديد.`);
    expect([...body.querySelectorAll("bdi")].map((bdi) => bdi.textContent)).toEqual([NAME, NAME]);
  });

  it("the chat info panel: its title, Shared by (and its region's name), the deck's name and the nothing-else line", () => {
    const view = renderApp(<ContactIdentitiesPanel peerKey="peer" name={NAME} onClose={vi.fn()} />, { language: "ar" });
    act(() => view.engine.update({ links: [paired()] }));
    const panel = screen.getByTestId("chat-identities");
    const title = within(panel).getByRole("heading", { level: 2 });
    expect(title).toHaveTextContent(`الهويات مع ${NAME}`);
    expect(isolated(title)).toBe(true);
    const received = screen.getByTestId("chat-identities-received");
    const sharedBy = within(received).getByRole("heading", { level: 3 });
    expect(sharedBy).toHaveTextContent(`شاركها ${NAME}`);
    expect(isolated(sharedBy)).toBe(true);
    expect(received).toHaveAttribute("aria-label", `شاركها ${ISOLATED}`);
    expect(within(received).getByRole("radiogroup")).toHaveAttribute("aria-label", `الهويات التي شاركها ${ISOLATED}`);
    const none = screen.getByTestId("chat-identities-none");
    expect(none).toHaveTextContent(`لم تشارك ${NAME} أي شيء آخر بعد.`);
    expect(isolated(none)).toBe(true);
  });

  it("the chat header's identities: the phone menu's row and the marks' name", () => {
    renderApp(<>
      <IdentityMenuItem peerKey="peer" name={NAME} keyLabel="peer" onOpen={vi.fn()} />
      <IdentityStack peerKey="peer" name={NAME} onOpen={vi.fn()} />
    </>, { language: "ar" });
    const [row, stack] = screen.getAllByTestId("chat-identity-badges");
    expect(row).toHaveTextContent(`الهويات مع ${NAME}`);
    expect(isolated(row!)).toBe(true);
    const label = stack!.getAttribute("aria-label")!;
    expect(label.startsWith(`الهويات مع ${ISOLATED}`)).toBe(true);
    expect(label).toContain(`لم تشارك ${ISOLATED} أي شيء آخر بعد.`);
  });

  it("the chat's Shared services: its title, the line under it, From and each app's switch", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    try {
      fakeEngine.update({ services: [{ id: "mine", name: "Notes", target: "http://localhost:3400", enabled: true, requests: 0, createdAt: 1 }] });
      renderApp(<ChatServicesDialog peerPubKey="peer" name={NAME} onClose={vi.fn()} />, { language: "ar" });
      const dialog = screen.getByTestId("chat-services");
      const title = within(dialog).getByRole("heading", { level: 2 });
      expect(title).toHaveTextContent(`الخدمات المشتركة مع ${NAME}`);
      expect(isolated(title)).toBe(true);
      const pick = title.nextElementSibling!;
      expect(pick).toHaveTextContent(`يمكن لـ ${NAME} فتحها.`);
      expect(isolated(pick)).toBe(true);
      const from = within(dialog).getAllByRole("heading", { level: 3 }).find((h) => h.textContent === `من ${NAME}`)!;
      expect(isolated(from)).toBe(true);
      const grant = await screen.findByTestId("chat-service-grant");
      expect(within(grant).getByTestId("chat-service-toggle")).toHaveAttribute("aria-label", `السماح لـ ${ISOLATED} بفتح \u2068Notes\u2069`);
    } finally {
      fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false };
    }
  });

  it("a contact's app, named in the view it opens in: its notices, the host's error page and the view's name", () => {
    const t = translatorFor("ar");
    const words = serviceAppWords(APP, t);
    expect(words.loading).toBe(`جارٍ فتح ${APP_ISOLATED} على جهاز جهة اتصالك…`);
    for (const [line, said] of Object.entries(words)) expect(said, line).toContain(APP_ISOLATED);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(hostErrorText([["x-ghostly-error", "unreachable"]], APP, t)).toContain(`${APP_ISOLATED} لا يستجيب`);
    expect(serviceFraming(APP, { nick: "Demo bot" }, "peer", t).label).toBe(`${APP_ISOLATED}، يشاركه ⁨Demo bot⁩`);
  });

  it("a contact's app on its Open buttons: the Shared services dialog's and the chat strip's", () => {
    fakeEngine.features = { ...fakeEngine.features, openServices: true };
    try {
      const view = renderApp(<>
        <PeerServices peerPubKey="peer" onManage={vi.fn()} />
        <ChatServicesDialog peerPubKey="peer" name={NAME} onClose={vi.fn()} />
      </>, { language: "ar" });
      act(() => view.engine.update({ links: [paired({ sessionOffers: { mine: ["services/1"], peer: ["services/1"] },
        capabilities: { files: true, payments: false, services: true }, peerServices: [{ id: "notes", type: "http", name: APP }] })] }));
      const said = `فتح ${APP_ISOLATED}، يُقدَّم من جهاز جهة اتصالك`;
      expect(screen.getByTestId("chat-service-open")).toHaveAttribute("aria-label", said);
      expect(screen.getByTestId("open-service")).toHaveAttribute("title", said);
    } finally {
      fakeEngine.features = { ...fakeEngine.features, openServices: false };
    }
  });

  it("the chat's Hold dialog: its title, the line under it, what is held and what was refused", () => {
    const MB = 1024 * 1024;
    const hold: PeerHoldState = { enabled: true, peerAllows: true, storage: true, canHold: true, outstanding: 2, bytes: 1.5 * MB, maxBytes: 64 * MB, maxItems: 64, ttlMs: 7 * 86_400_000, refused: 3 };
    renderApp(<ChatHoldDialog peer={{ hold } as PeerLinkState} name={NAME} onSave={vi.fn()} onClose={vi.fn()} />, { language: "ar" });
    const dialog = screen.getByTestId("chat-hold");
    const title = within(dialog).getByRole("heading");
    expect(title).toHaveTextContent(`الاحتفاظ بالرسائل لـ ${NAME}`);
    expect(isolated(title)).toBe(true);
    const intro = title.nextElementSibling!;
    expect(intro).toHaveTextContent(`أثناء غياب ${NAME}، ينتظر ما ترسله`);
    expect(intro).toHaveTextContent("لمدة تصل إلى 7 أيام");
    expect(isolated(intro)).toBe(true);
    const quota = screen.getByTestId("chat-hold-quota");
    expect(quota).toHaveTextContent(`محفوظ لـ ${NAME}: 2 من 64`);
    expect(isolated(quota)).toBe(true);
    const refused = screen.getByTestId("chat-hold-refused");
    expect(refused).toHaveTextContent(`تعذّر التحقق من 3 عناصر محفوظة من ${NAME} فرُفضت.`);
    expect(isolated(refused)).toBe(true);
  });

  it("the chat's Apps", () => {
    fakeEngine.on("appList", () => []);
    renderApp(<ChatAppsDialog linkId="link-1" name={NAME} onClose={vi.fn()} />, { language: "ar" });
    const title = within(screen.getByTestId("chat-apps")).getByRole("heading");
    expect(title).toHaveTextContent(`التطبيقات مع ${NAME}`);
    expect(isolated(title)).toBe(true);
  });

  it("the composer's identity card turned over: What the contact sees, and the note on stopping", async () => {
    const view = renderApp(<ComposerIdentityPicker peerKey="peer" contact={NAME} onClose={vi.fn()} />, { language: "ar" });
    document.documentElement.dataset.reduceMotion = "true";
    act(() => view.engine.update({ links: [paired({ identities: identitiesView({ shared: [sharedView({ id: "on" })] }) })], identityProofs: [proofView({ id: "on" })] }));
    await view.user.click(screen.getByTestId("composer-identity-use"));
    await waitFor(() => expect(screen.getByTestId("composer-identity-share")).toHaveFocus());
    const back = screen.getByTestId("composer-identity-back");
    const title = back.querySelector(".id-card-back-title")!;
    expect(title).toHaveTextContent(`ما يراه ${NAME}`);
    expect(isolated(title)).toBe(true);
    const note = back.querySelector(".id-card-back-note")!;
    expect(note).toHaveTextContent(`الإيقاف يُبلغ ${NAME}؛`);
    expect(isolated(note)).toBe(true);
  });

  it("the composer's Ghostly card turned over: What the contact sees", async () => {
    const view = renderApp(<ComposerIdentityPicker peerKey="peer" contact={NAME} onClose={vi.fn()} />, { language: "ar" });
    document.documentElement.dataset.reduceMotion = "true";
    act(() => view.engine.update({ settings: { nick: "Ghost" }, links: [paired({ myPubKeyZ32: "yzk3gq8qpjb1g4mzr3ff3kr1j4c1b7dxy8dd3mkwqc9k7p3e1mio" })], identityProofs: [proofView({ id: "a" })] }));
    await view.user.click(screen.getByTestId("composer-identity-ghostly"));
    await waitFor(() => expect(screen.getByTestId("composer-identity-copy-key")).toHaveFocus());
    const title = screen.getByTestId("composer-identity-back").querySelector(".id-card-back-title")!;
    expect(title).toHaveTextContent(`ما يراه ${NAME}`);
    expect(isolated(title)).toBe(true);
  });
});
