import { Profiler, type ReactElement } from "react";
import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AccountBar } from "../../components/AccountBar";
import { MobileTabBar } from "../../components/MobileTabBar";
import { fakeEngine, linkView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";
import { DAY, identitiesView, now, proofView, receivedView } from "./views";

// covers: proofs.badges

/**
 * The sidebar's account bar and a phone's tab bar are always on screen, and both carry the Identities dot. The engine
 * sends its whole state anew on every change, up to 20 times a second while a file moves: the bars draw again only
 * when what the dot reads changes.
 */

const withNews = (status: "verified" | "revoked"): StatePatch => ({
  identityProofs: [proofView()],
  links: [linkView({ identities: identitiesView({ received: [receivedView({ status })] }) })],
});
/** The state as the engine sends it after a change elsewhere: the same content, every object new. */
const sentAgain = (patch: StatePatch = {}) => act(() => fakeEngine.setState({ ...structuredClone(fakeEngine.state), ...patch } as StatePatch));

const bars: [string, () => ReactElement][] = [["the account bar", () => <AccountBar />], ["a phone's tab bar", () => <MobileTabBar />]];

describe.each(bars)("%s on an engine state", (_, bar) => {
  it("is not drawn again when nothing the Identities dot reads changed", () => {
    fakeEngine.setState(withNews("verified"));
    let draws = 0;
    renderApp(<Profiler id="bar" onRender={() => { draws++; }}>{bar()}</Profiler>);
    expect(screen.queryByTestId("identities-attention")).not.toBeInTheDocument();
    const before = draws;
    for (let i = 0; i < 5; i++) sentAgain({ transfers: { [`file-${i}`]: { state: "transferring", transferred: i * 1000, size: 10_000 } } });
    expect(draws - before).toBe(0);
  });

  it("shows the dot when a contact's proof is revoked, and when one of mine is about to expire", () => {
    fakeEngine.setState(withNews("verified"));
    renderApp(bar());
    expect(screen.queryByTestId("identities-attention")).not.toBeInTheDocument();
    sentAgain(withNews("revoked"));
    expect(screen.getByTestId("identities-attention")).toBeInTheDocument();
    sentAgain(withNews("verified"));
    expect(screen.queryByTestId("identities-attention")).not.toBeInTheDocument();
    sentAgain({ identityProofs: [proofView({ issuedAt: now() - 80 * DAY, expiresAt: now() + DAY })] });
    expect(screen.getByTestId("identities-attention")).toBeInTheDocument();
  });
});
