// The identity readers that list every chat (a contact's identities beside the chat: the names its activity's chips
// show; Identities → From your contacts; the chat list's faces) read an entry per chat. The engine sends its whole
// state anew on every change (up to 20 a second while a file moves) with every chat it did not change as the same view:
// a state that changed no chat builds no entry and reads none of them, and what each reader shows is what it showed
// when it built every entry anew on each state (the old readers, kept here as the oracle).
import { useMemo } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkView, PublicGraphView, ReceivedIdentityView } from "@ghostly/browser/shared/types";
import { ContactIdentitiesSection } from "../../components/identities/ContactIdentitiesSection";
import { chipLinks, receivedByKey, sharingLinks } from "../../components/identities/contactLinks";
import { contactFace, faceChoice, setFaceChoice, useContactFaces, useFaceChoices, type ContactFace } from "../../components/identities/contactFace";
import { IdentityActivity, type ChipLink } from "../../components/identities/IdentityActivity";
import { ProviderMark, StatusPill } from "../../components/identities/ProviderMark";
import { Button, Row, Section } from "../../components/wallet/ui";
import { useI18n } from "../../contexts/I18nContext";
import { useAppNavigation } from "../../hooks/useAppNavigation";
import { categoryLabel, chatsByPeer, contactName, currentStatus, dateTime, providerLabel, receivedStatus, shortSubject, useEngineValue } from "../../lib/identities";
import { contactTag } from "../../lib/publicKeyLabel";
import { saveSession } from "../../lib/storage";
import { chatPath } from "../../lib/url";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { DAY, identitiesView, now, receivedView } from "./views";

// covers: proofs.contact-face, proofs.public-activity.graph, proofs.page

type State = { links: LinkView[] } | null | undefined;

// The readers as they were, each building every chat's entry on every state: the oracle.
const oldPanelLinks = (state: State) => (state?.links ?? []).map((l): ChipLink => ({ id: l.id, peerPubKeyZ32: l.peerPubKeyZ32, identities: l.identities && { received: l.identities.received } }));
const oldSectionLinks = (state: State) => (state?.links ?? []).flatMap(link => (link.identities?.received.length ? [{ peerPubKeyZ32: link.peerPubKeyZ32, identities: { received: link.identities.received } }] : []));
const oldReceivedByKey = (state: State): [peerKey: string, received: ReceivedIdentityView[]][] =>
  (state?.links ?? []).flatMap((l) => (l.identities?.received ? [[l.peerPubKeyZ32, l.identities.received] as [string, ReceivedIdentityView[]]] : []));

const ORDER: Record<string, number> = { revoked: 0, unconfirmed: 0, verified: 1 };
/** ContactIdentitiesSection as it was, on the old reader. */
function OldSection() {
  const links = useEngineValue(oldSectionLinks);
  const nav = useAppNavigation();
  const { t } = useI18n();
  const chats = links.length ? chatsByPeer() : new Map();
  const received = links.flatMap(link => {
    const chat = chats.get(link.peerPubKeyZ32);
    return link.identities!.received.map(r => ({ r, status: currentStatus(r), chat, name: contactName(chat) ?? t("common.unnamedContact", { key: contactTag(link.peerPubKeyZ32) }) }));
  }).sort((a, b) => (ORDER[a.status] ?? 2) - (ORDER[b.status] ?? 2));
  if (!received.length) return null;
  return (
    <Section title={t("identities.received.title")} testId="identities-received">
      {received.map(({ r, status, chat, name }) => (
        <Row key={`${chat?.id}/${r.id}`} testId="identity-received" leading={<ProviderMark provider={r.provider} subject={r.subject} />}
          label={<span className="flex flex-wrap items-center gap-2"><span>{name}</span><StatusPill ok={status === "verified"} warn={status === "revoked" || status === "unconfirmed"} testId="identity-received-status">{receivedStatus(status, t)}</StatusPill></span>}
          hint={<>
            <span>{providerLabel(r.provider, t)} ·<span className="font-mono break-all" title={r.subject}>{shortSubject(r.provider, r.subject)}</span></span>
            <span className="block">{t("identities.received.checked", { category: categoryLabel(r.provider, r.verified.attester, t), time: dateTime(r.checkedAt, t.language) })}</span>
          </>}>
          {chat && <Button data-testid="identity-received-open" onClick={() => nav.conversation(chatPath(chat.id))}>{t("identities.openChat")}</Button>}
        </Row>
      ))}
    </Section>
  );
}

const shownFace = (face: ContactFace | undefined) => (face ? `${face.id}|${face.name ?? ""}|${face.photo ?? ""}` : "-");
/** The chat list's faces, as `useContactFaces` gives them. */
function NewFaces({ keys }: { keys: string[] }) {
  const faceOf = useContactFaces();
  return <ul>{keys.map(k => <li key={k}>{k.slice(0, 4)}:{shownFace(faceOf(k))}</li>)}</ul>;
}
/** The same, on the old reader. */
function OldFaces({ keys }: { keys: string[] }) {
  const received = useEngineValue(oldReceivedByKey);
  useFaceChoices();
  const byKey = useMemo(() => new Map([...received].reverse()), [received]);
  return <ul>{keys.map(k => <li key={k}>{k.slice(0, 4)}:{shownFace(contactFace(byKey.get(k), faceChoice(k)))}</li>)}</ul>;
}

const SUBJECT = "y".repeat(52);
/** The activity's chips, named from the panel's list of chats. */
function NewChips() { return <IdentityActivity provider="pubky" subject={SUBJECT} links={useEngineValue(state => chipLinks(state?.links))} />; }
function OldChips() { return <IdentityActivity provider="pubky" subject={SUBJECT} links={useEngineValue(oldPanelLinks)} />; }

/** A small seeded generator, so a failing round can be replayed. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] };
}
type Random = ReturnType<typeof random>;

const KEYS = Array.from({ length: 24 }, (_, i) => `k${String(i).padStart(2, "0")}`.padEnd(52, "x"));
const PHOTO = "data:image/jpeg;base64,/9j/2Q==";

function someReceived(rnd: Random, tag: string): ReceivedIdentityView[] {
  return Array.from({ length: rnd.int(5) }, (_, j) => {
    const pubky = rnd.next() < 0.6, subject = pubky ? `${tag}${j}`.padEnd(52, "y") : `${tag}-${j}.example.org`;
    const status = rnd.pick(["verified", "verified", "verified", "revoked", "unconfirmed"] as const);
    return receivedView({
      id: `r-${tag}-${j}`, provider: pubky ? "pubky" : "domain", subject, verified: { subject, source: "x" }, status,
      expiresAt: rnd.next() < 0.15 ? now() - DAY : now() + 30 * DAY,
      ...(pubky && rnd.next() < 0.8 ? { publicProfile: { found: true, name: `Name ${tag} ${j}`, ...(rnd.next() < 0.5 ? { avatar: PHOTO } : {}), hosts: ["h"], fetchedAt: now() - 3600 } } : {}),
    });
  });
}

/** The chats, as the engine holds them: each view kept as the same object until that chat changes. */
class World {
  views: LinkView[] = [];
  private made = 0;
  private stamp = 0;
  constructor(private rnd: Random) {}
  private view(patch: Partial<LinkView> & Pick<LinkView, "id" | "peerPubKeyZ32">): LinkView {
    return linkView({ createdAt: ++this.stamp, pairing: { status: "ready" } as LinkView["pairing"], ...patch });
  }
  add() {
    const { rnd } = this;
    const id = `link-${this.made++}`;
    const used = this.views.map(v => v.peerPubKeyZ32);
    // Mostly a contact with no chat yet; now and then a second chat with someone (the first one names them).
    const free = KEYS.filter(k => !used.includes(k));
    const key = free.length && rnd.next() < 0.85 ? rnd.pick(free) : rnd.pick(KEYS);
    const paired = rnd.next() < 0.8;
    this.views.push(this.view({ id, peerPubKeyZ32: key, ...(paired ? { identities: identitiesView({ received: someReceived(rnd, id) }) } : {}) }));
  }
  private replace(i: number, patch: Partial<LinkView>) {
    const old = this.views[i];
    const next = { ...old, ...patch };
    if (!("identities" in patch) && old.identities) next.identities = structuredClone(old.identities);
    this.views = this.views.map((v, j) => (j === i ? next : v));
  }
  /** One step of what happens to the chats, then the engine's next state. */
  step(): string {
    const { rnd } = this;
    const i = this.views.length ? rnd.int(this.views.length) : -1;
    const op = this.views.length < 3 ? "add" : rnd.pick(["add", "add", "remove", "identities", "touch", "touch", "rename", "unpair", "pair", "same", "same", "choose", "reorder"] as const);
    switch (op) {
      case "add": this.add(); break;
      case "remove": this.views = this.views.filter((_, j) => j !== i); break;
      case "identities": this.replace(i, { identities: identitiesView({ received: someReceived(rnd, `${this.views[i].id}-${this.stamp++}`) }) }); break;
      // The chat changed and not what the readers show (a message, typing): a new view, its identities copied anew.
      case "touch": this.replace(i, { lastMessageAt: ++this.stamp, peerTyping: rnd.next() < 0.5 }); break;
      case "rename": {
        const name = `Nick ${this.stamp++}`;
        saveSession({ id: `s-${this.views[i].id}`, mySeedB64: "seed", peerPubKeyB64: this.views[i].peerPubKeyZ32, encKeyB64: "enc", messages: [], createdAt: 0, label: name } as ChatSession);
        this.replace(i, { peerNick: name });
        break;
      }
      case "unpair": this.replace(i, { identities: undefined }); break;
      case "pair": this.replace(i, { identities: identitiesView({ received: someReceived(rnd, `${this.views[i].id}-p${this.stamp++}`) }) }); break;
      case "same": break;
      case "choose": {
        const key = rnd.pick(KEYS);
        const r = this.views.find(v => v.peerPubKeyZ32 === key)?.identities?.received.find(x => x.provider === "pubky");
        setFaceChoice(key, r && rnd.next() < 0.8 ? { provider: r.provider, subject: r.subject } : rnd.next() < 0.5 ? "none" : undefined);
        break;
      }
      // The engine orders chats by when they were made; a list sent again in another order still names the same.
      case "reorder": { const j = rnd.int(this.views.length); [this.views[i], this.views[j]] = [this.views[j], this.views[i]]; this.views = [...this.views]; break; }
    }
    return op;
  }
  /** A new list every state, as the engine sends it. */
  list(): LinkView[] { return [...this.views]; }
}

const withoutId = (links: readonly ChipLink[]) => links.map(({ peerPubKeyZ32, identities }) => ({ peerPubKeyZ32, identities }));

describe("the identity readers that list every chat", () => {
  // Statuses and badges read the clock in whole seconds: it stands still here, so both readers see the same second.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("read what the old readers read, over random chats coming, going and changing, and the same list while none changed", () => {
    let rounds = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rnd = random(seed), world = new World(rnd);
      for (let i = 0; i < 10; i++) world.add();
      let lastChips: readonly ChipLink[] | undefined, lastViews: readonly LinkView[] = [];
      for (let round = 0; round < 400; round++, rounds++) {
        const op = world.step();
        const links = world.list(), state = { links };
        const where = `seed ${seed}, round ${round} (${op})`;
        const chips = chipLinks(links);
        expect(chips, where).toEqual(oldPanelLinks(state));
        expect(withoutId(sharingLinks(links)), where).toEqual(oldSectionLinks(state));
        expect(receivedByKey(links), where).toEqual(oldReceivedByKey(state));
        // The same chats as the last list's: the same list, not one built anew.
        if (lastChips && links.length === lastViews.length && links.every((v, j) => v === lastViews[j])) expect(chips, where).toBe(lastChips);
        // A chat changed and not whose it is or what they shared (a message, a new name): still the same list.
        if (lastChips && (op === "touch" || op === "rename")) expect(chips, where).toBe(lastChips);
        // Asked again for one state (another reader of it): the same lists.
        expect(chipLinks(links)).toBe(chips);
        expect(sharingLinks(links)).toBe(sharingLinks(links));
        expect(receivedByKey(links)).toBe(receivedByKey(links));
        lastChips = chips; lastViews = links;
      }
    }
    expect(rounds).toBe(3200);
    expect(chipLinks(undefined)).toEqual([]);
    expect(sharingLinks([])).toEqual([]);
    expect(receivedByKey(undefined)).toEqual([]);
  });

  it("show what the old readers showed: the chips' names, the chat list's faces and the Identities rows", async () => {
    const graph: PublicGraphView = {
      compared: true, followsYou: false, youFollow: false, hosts: ["nexus.pubky.app"], fetchedAt: now(),
      // Chats that exist and chats that never did (or are gone): each chip named by the chats the state holds.
      contacts: Array.from({ length: 120 }, (_, i) => ({ linkId: `link-${i}`, follows: i % 2 === 0, followedBy: i % 3 === 0 })),
    };
    fakeEngine.on("loadPublicGraph", () => graph);
    fakeEngine.on("loadPublicPosts", () => ({ posts: [], more: false, hosts: ["nexus.pubky.app"], fetchedAt: now() }));
    fakeEngine.on("loadPublicProfile", () => undefined);
    renderApp(<>
      <div data-testid="new-faces"><NewFaces keys={KEYS} /></div><div data-testid="old-faces"><OldFaces keys={KEYS} /></div>
      <div data-testid="new-section"><ContactIdentitiesSection /></div><div data-testid="old-section"><OldSection /></div>
      <div data-testid="new-chips"><NewChips /></div><div data-testid="old-chips"><OldChips /></div>
    </>);
    await waitFor(() => expect(within(screen.getByTestId("new-chips")).getAllByTestId("contact-activity-contact")).toHaveLength(120));
    await waitFor(() => expect(within(screen.getByTestId("old-chips")).getAllByTestId("contact-activity-contact")).toHaveLength(120));
    const chipsOf = (box: string) => within(screen.getByTestId(box)).getAllByTestId("contact-activity-contact").map(c => `${c.getAttribute("data-link")}=${c.getAttribute("aria-label")}`);
    const html = (box: string) => screen.getByTestId(box).innerHTML;

    let rounds = 0, faces = 0, rows = 0, named = 0;
    for (const seed of [11, 12, 13]) {
      const rnd = random(seed), world = new World(rnd);
      for (let i = 0; i < 12; i++) world.add();
      for (let round = 0; round < 60; round++, rounds++) {
        const op = world.step();
        act(() => fakeEngine.update({ links: world.list() }));
        const where = `seed ${seed}, round ${round} (${op})`;
        expect(html("new-faces"), where).toBe(html("old-faces"));
        expect(html("new-section"), where).toBe(html("old-section"));
        expect(chipsOf("new-chips"), where).toEqual(chipsOf("old-chips"));
        faces += within(screen.getByTestId("new-faces")).queryAllByText(/\|Name /).length;
        rows += within(screen.getByTestId("new-section")).queryAllByTestId("identity-received").length;
        named += chipsOf("new-chips").filter(c => /Nick |Name /.test(c)).length;
      }
    }
    expect(rounds).toBe(180);
    // The rounds showed something to compare: faces chosen, rows on the page, chips named by a nickname or a face.
    expect(faces).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
    expect(named).toBeGreaterThan(0);
  }, 120_000);
});
