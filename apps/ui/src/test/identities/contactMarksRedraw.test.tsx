import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContactMarks } from "../../components/identities/ContactMarks";
import { fakeEngine, linkView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";
import { identitiesView, receivedView } from "./views";

// covers: proofs.badges

/**
 * A chat list draws a contact's marks on each row. The engine sends its whole state anew on every change, up to 20
 * times a second while a file moves: the marks draw again only when the contact's identities change.
 */

const PEER = "p".repeat(52);
const received = (n: number) => [
  receivedView({ id: "github", provider: "ssh-github", subject: "octocat" }),
  receivedView({ id: "domain", provider: "domain", subject: "example.org" }),
  receivedView({ id: "nostr", provider: "nostr", subject: "npub1example" }),
].slice(0, n);
const withMarks = (n: number): StatePatch => ({ links: [linkView({ peerPubKeyZ32: PEER, identities: identitiesView({ received: received(n) }) })] });
/** The state as the engine sends it after a change elsewhere: the same content, every object new. */
const sentAgain = (patch: StatePatch = {}) => act(() => fakeEngine.setState({ ...structuredClone(fakeEngine.state), ...patch } as StatePatch));

describe("a contact's marks on an engine state", () => {
  it("are not drawn again when the contact's identities did not change", async () => {
    fakeEngine.setState(withMarks(2));
    let draws = 0;
    renderApp(<Profiler id="marks" onRender={() => { draws++; }}><ContactMarks peerKey={PEER} /></Profiler>);
    expect(await screen.findByTestId("contact-marks")).toHaveAttribute("data-count", "2");
    const before = draws;
    for (let i = 0; i < 5; i++) sentAgain({ transfers: { [`file-${i}`]: { state: "transferring", transferred: i * 1000, size: 10_000 } } });
    expect(draws - before).toBe(0);
  });

  it("are drawn again when they change", async () => {
    fakeEngine.setState(withMarks(2));
    renderApp(<ContactMarks peerKey={PEER} />);
    expect(await screen.findByTestId("contact-marks")).toHaveAttribute("data-count", "2");
    sentAgain(withMarks(3));
    expect(screen.getByTestId("contact-marks")).toHaveAttribute("data-count", "3");
    sentAgain(withMarks(0));
    expect(screen.queryByTestId("contact-marks")).not.toBeInTheDocument();
  });
});
