// The engine sends its whole state anew on every change (up to 20 a second while a file moves), with every chat it did
// not change as the same view. The identity readers that list every chat (a contact's identities beside the chat, whose
// activity's chips name contacts; Identities → From your contacts; the chat list's faces) read no chat on a state that
// changed none, only the chat that changed on one that did, and a contact whose identities changed draws what shows
// them and not another contact's face.
import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { ContactIdentitiesPanel } from "../../components/identities/ContactIdentitiesPanel";
import { ContactIdentitiesSection } from "../../components/identities/ContactIdentitiesSection";
import { useContactFace, useContactFaces } from "../../components/identities/contactFace";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { identitiesView, receivedView } from "./views";

// covers: proofs.contact-face, proofs.page

const keyOf = (i: number) => `c${i}`.padEnd(52, "x");
/** A chat whose identities are counted each time they are read (all but the panel's contact's). */
function chat(i: number, reads: { n: number }, tag = ""): LinkView {
  const identities = identitiesView({ received: [receivedView({ id: `r${i}`, provider: "domain", subject: `s${i}${tag}.example.org`, verified: { subject: `s${i}${tag}.example.org`, source: "x" } })] });
  const view = linkView({ id: `link-${i}`, peerPubKeyZ32: keyOf(i), createdAt: i, pairing: { status: "ready" } as LinkView["pairing"] });
  if (i === 0) return { ...view, identities };
  Object.defineProperty(view, "identities", { get() { reads.n++; return identities; }, enumerable: true, configurable: true });
  return view;
}

function Faces() { useContactFaces(); return null; }
function OneFace({ k }: { k: string }) { useContactFace(k); return null; }

describe("an engine state that changed no chat", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("reads no chat's identities in the panel, the Identities rows or the chat list's faces, at 500 chats", () => {
    const reads = { n: 0 };
    let views = Array.from({ length: 500 }, (_, i) => chat(i, reads));
    const view = renderApp(<>
      <ContactIdentitiesPanel peerKey={keyOf(0)} name="Chat 0" onClose={() => {}} />
      <ContactIdentitiesSection />
      <Faces />
    </>);
    act(() => view.engine.update({ links: views }));
    expect(screen.getAllByTestId("identity-received")).toHaveLength(500);

    // The engine's next states: a new list holding the same chats' views (a file moving, a contact's presence).
    reads.n = 0;
    for (let s = 0; s < 20; s++) act(() => view.engine.update({ links: [...views] }));
    expect(reads.n).toBe(0);

    // One chat changed (a message): its view is new, with what the readers show unchanged; only that chat is read.
    views = views.map((v, i) => (i === 7 ? chat(7, reads) : v));
    reads.n = 0;
    act(() => view.engine.update({ links: views }));
    expect(reads.n).toBeGreaterThan(0);
    expect(reads.n).toBeLessThanOrEqual(4);
  });

  it("draws nothing, and a contact whose identities changed draws what shows them and not another contact's face", () => {
    const reads = { n: 0 };
    let views = Array.from({ length: 50 }, (_, i) => chat(i, reads));
    const commits: Record<string, number> = { panel: 0, section: 0, faces: 0, face3: 0, face4: 0 };
    const count = (id: string) => () => { commits[id]++; };
    const view = renderApp(<>
      <Profiler id="panel" onRender={count("panel")}><ContactIdentitiesPanel peerKey={keyOf(0)} name="Chat 0" onClose={() => {}} /></Profiler>
      <Profiler id="section" onRender={count("section")}><ContactIdentitiesSection /></Profiler>
      <Profiler id="faces" onRender={count("faces")}><Faces /></Profiler>
      <Profiler id="face3" onRender={count("face3")}><OneFace k={keyOf(3)} /></Profiler>
      <Profiler id="face4" onRender={count("face4")}><OneFace k={keyOf(4)} /></Profiler>
    </>);
    act(() => view.engine.update({ links: views }));
    const zero = () => { for (const k of Object.keys(commits)) commits[k] = 0; };

    zero();
    for (let s = 0; s < 20; s++) act(() => view.engine.update({ links: [...views] }));
    // A chat changed and nothing the readers show of it (new view, its identities copied anew).
    views = views.map((v, i) => (i === 9 ? chat(9, reads) : v));
    act(() => view.engine.update({ links: views }));
    expect(commits).toEqual({ panel: 0, section: 0, faces: 0, face3: 0, face4: 0 });

    // Contact 3's identity changed: its face and the lists that hold it draw again; contact 4's face does not.
    views = views.map((v, i) => (i === 3 ? chat(3, reads, "-new") : v));
    act(() => view.engine.update({ links: views }));
    expect(commits.face3).toBeGreaterThan(0);
    expect(commits.section).toBeGreaterThan(0);
    expect(commits.faces).toBeGreaterThan(0);
    expect(commits.face4).toBe(0);
    expect(screen.getAllByTestId("identity-received").some(row => row.textContent?.includes("s3-new.example.org"))).toBe(true);
  });
});
