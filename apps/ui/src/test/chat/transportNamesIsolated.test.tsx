import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ChatConnection } from "../../components/ChatConnection";
import { ConnectionHistory, TransportLine } from "../../components/TransportTimeline";
import type { TransportEntry, TransportEvent } from "../../lib/transportEvents";
import type { Language } from "../../lib/settings";
import { translateWith, type TranslationKey } from "../../locales/translate";
import { linkView } from "../fakeEngine";
import { LOCALES } from "../i18n/locales";
import { renderApp } from "../render";

// covers: transport.timeline, transport.wait

/*
 * The contact's name in the chat's transport lines and in the connection panel's history, waiting and not-live boxes:
 * its own <bdi>, as the chat info panel and the chat's dialogs have it. Put into the sentence as plain text, a Latin
 * name with a bracket at its edge beside a Latin transport name made one run in an Arabic line: "اختار Ana (work)
 * HyperDHT" read with the bracket and the transport on the wrong side. English is the control: the same <bdi>, the same
 * words. The text is compared through `textContent`, which adds nothing around a <bdi> (happy-dom's accessible name does).
 */

type Pairing = NonNullable<LinkView["pairing"]>;
const ALL = ["webrtc/1", "iroh/1", "hyperdht/1"] as LinkView["availableTransports"];
const NAMES = ["Ana (work)", "سارة (عمل)"];
const LANGUAGES: Language[] = ["ar", "en"];

/** The sentence as the language says it, with the name put in plainly: what the line reads once the <bdi> is drawn. */
const said = (language: Language, key: TranslationKey, params: Record<string, string>) => translateWith(LOCALES[language], language)(key, params);

/** The names each in a <bdi> of their own inside the element, in order. */
const isolated = (el: Element) => [...el.querySelectorAll("bdi")].map((bdi) => bdi.textContent);

/** No placeholder left in what is drawn, with or without a name. */
const noSlot = (el: Element) => expect(el.textContent).not.toContain("{{");

const down = (patch: Partial<LinkView>) => linkView({ availableTransports: ALL, peerTransports: ALL, dataLink: "idle", textDelivery: "dht",
  pairing: { status: "connecting" } as Pairing, peerParticipationKey: "pk", ...patch });
const live = (patch: Partial<LinkView>) => linkView({ availableTransports: ALL, peerTransports: ALL, dataLink: "open", textDelivery: "stream",
  pairing: { status: "ready", transport: "webrtc/1" } as Pairing, peerParticipationKey: "pk", ...patch });

describe.each(LANGUAGES)("the contact's name in the transport lines and the connection panel, in %s", (language) => {
  describe.each(NAMES)("named %s", (NAME) => {
    it("the chat's transport lines, their details and the lines before them", async () => {
      const at = Date.now();
      const chose: TransportEntry = { id: "l1", at: at - 2000, kind: "chose", cause: "contact", target: "hyperdht/1" } as TransportEntry;
      const dhtOnly: TransportEntry = { id: "l2", at: at - 1000, kind: "dht-only", cause: "contact" } as TransportEntry;
      const lost: TransportEntry = { id: "l3", at, kind: "lost", from: "webrtc/1", fallback: "hold" } as TransportEntry;
      const view = renderApp(<div data-testid="lines">
        <TransportLine entry={chose} contact={NAME} />
        <TransportLine entry={dhtOnly} contact={NAME} />
        <TransportLine entry={lost} earlier={[chose, dhtOnly]} contact={NAME} />
      </div>, { language });
      const lines = within(screen.getByTestId("lines")).getAllByTestId("transport-line-text");
      expect(lines.map((line) => line.textContent)).toEqual([
        said(language, "connection.line.contactChose", { contact: NAME, transport: "HyperDHT" }),
        said(language, "connection.line.contactDhtOnly", { contact: NAME }),
        said(language, "connection.line.lostHold", { contact: NAME }),
      ]);
      for (const line of lines) expect(isolated(line)).toEqual([NAME]);
      // The line's button is named by its words, the name inside them.
      const button = lines[0]!.closest("button")!;
      expect(button.textContent!.replace(/\s+/g, " ")).toContain(said(language, "connection.line.contactChose", { contact: NAME, transport: "HyperDHT" }));

      // Tapped: Why says the name again, and so do the lines it stands for.
      await view.user.click(screen.getAllByTestId("transport-line")[0]!.querySelector("button")!);
      const details = screen.getByTestId("transport-line-details");
      const why = [...details.querySelectorAll("dd")].find((dd) => dd.textContent!.includes(NAME))!;
      expect(why.textContent).toBe(said(language, "connection.why.contactChoseMoves", { contact: NAME, transport: "HyperDHT" }));
      expect(isolated(why)).toEqual([NAME]);
      await view.user.click(screen.getAllByTestId("transport-line")[2]!.querySelector("button")!);
      const earlier = within(screen.getByTestId("transport-line-earlier")).getAllByRole("listitem");
      expect(earlier).toHaveLength(2);
      for (const item of earlier) expect(isolated(item)).toEqual([NAME]);
      noSlot(screen.getByTestId("lines"));
    });

    it("the connection panel's history", () => {
      const at = Date.now();
      const events = [
        { at: at - 4000, kind: "chose", cause: "contact", target: "iroh/1" },
        { at: at - 3000, kind: "switched", cause: "contact", from: "webrtc/1", transport: "iroh/1" },
        { at: at - 2000, kind: "down", from: "iroh/1", text: "hold" },
        { at: at - 1000, kind: "dht-only", cause: "contact" },
      ] as TransportEvent[];
      renderApp(<ConnectionHistory events={events} contact={NAME} />, { language });
      const items = screen.getAllByTestId("connection-history-event");
      expect(items).toHaveLength(4);
      for (const item of items) expect(isolated(item)).toEqual([NAME]);
      const text = (item: Element) => item.querySelector("span")!.textContent;
      expect(text(items[3]!)).toBe(said(language, "connection.line.contactChose", { contact: NAME, transport: "Iroh" }));
      expect(text(items[0]!)).toBe(said(language, "connection.line.contactDhtOnly", { contact: NAME }));
      noSlot(screen.getByTestId("connection-history"));
    });

    it("the connection panel's waiting box", () => {
      const view = renderApp(<ChatConnection peerKey="peer" />, { language });
      act(() => view.engine.update({ links: [live({ peerNick: NAME, transportWait: { transport: "iroh/1", by: "contact", reason: "waiting", live: "webrtc/1" } as LinkView["transportWait"] })] }));
      const why = screen.getByTestId("connection-waiting-why");
      expect(why.textContent).toBe(said(language, "connection.wait.why", {
        who: said(language, "connection.line.contactChose", { contact: NAME, transport: "Iroh" }),
        reason: said(language, "connection.wait.waiting", { contact: NAME }),
      }));
      expect(isolated(why)).toEqual([NAME, NAME]);
      noSlot(screen.getByTestId("connection-waiting"));
    });

    it("the connection panel's not-live box", () => {
      const view = renderApp(<ChatConnection peerKey="peer" />, { language });
      act(() => view.engine.update({ links: [down({ peerNick: NAME, peerOnline: true, liveDialer: "contact",
        liveAttempt: { at: Date.now() - 60_000, side: "answered", failed: [{ transport: "webrtc/1", error: "ICE failed" }] } as LinkView["liveAttempt"] })] }));
      const box = screen.getByTestId("connection-not-live");
      const lines = [...box.querySelectorAll("p")].slice(1);
      expect(lines[0]!.textContent).toBe(said(language, "connection.attempt.contactDials", { contact: NAME }));
      expect(lines[1]!.textContent).toBe(said(language, "connection.attempt.answered", { contact: NAME }));
      expect(isolated(lines[0]!)).toEqual([NAME]);
      expect(isolated(lines[1]!)).toEqual([NAME]);
      noSlot(box);
    });
  });

  it("a contact with no name: the lines say \"your contact\" in their own words, nothing isolated and no placeholder", () => {
    const view = renderApp(<ChatConnection peerKey="peer" />, { language });
    act(() => view.engine.update({ links: [down({ peerOnline: true, liveDialer: "contact",
      liveAttempt: { at: Date.now() - 60_000, side: "answered", failed: [] } as unknown as LinkView["liveAttempt"],
      transportHistory: [{ at: Date.now() - 1000, kind: "chose", cause: "contact", target: "iroh/1" }] as LinkView["transportHistory"] })] }));
    const box = screen.getByTestId("connection-not-live");
    expect(box.textContent).toContain(said(language, "connection.attempt.contactDialsUnnamed", {}));
    expect(isolated(box)).toEqual([]);
    noSlot(box);
    const history = screen.getByTestId("connection-history");
    expect(history.textContent).toContain(said(language, "connection.line.contactChoseUnnamed", { transport: "Iroh" }));
    noSlot(history);
  });
});
