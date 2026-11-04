import { Profiler } from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCardId, statusCardText, type AppCard } from "@ghostly/core";
import type { LinkView } from "@ghostly/browser/shared/types";
import { MessageBubble } from "../../components/MessageBubble";
import { setAppOpener } from "../../lib/apps/open";
import { forgetAppsAvailable } from "../../lib/apps/flag";
import { forgetInstalledApps } from "../../lib/apps/installed";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine, linkView, type StatePatch } from "../fakeEngine";
import { renderApp } from "../render";

// covers: apps.chat.card

/**
 * The engine sends its whole state anew on every change, up to 20 times a second while a file moves. An app card in a
 * chat draws again only when what it shows of the contact changes (whether the app can talk to theirs now), so a chat
 * full of app cards does not redraw every card on every state, as its text rows don't.
 */

vi.mock("../../lib/apps/runnerCheck", () => ({ runnerAvailable: vi.fn(async () => true), runnerPolicy: vi.fn(async () => true), forgetRunnerCheck: () => {}, isRunnerPolicy: () => true }));

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", sequence: 7, title: "Chess",
  version: "1.2.0", url: "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp", opened: true };
const cardMessage = (id: string): ChatMessage => ({ id, text: statusCardText(CARD), card: CARD, sender: "peer", timestamp: 1_700_000_000_000 });
const ready = { status: "ready", transport: "iroh/1" } as NonNullable<LinkView["pairing"]>;
/** A paired chat with Ana; `live`: connected, both apps offering apps/1. */
const ana = (live: boolean) => linkView({ id: "link-1", peerPubKeyZ32: "peer", profile: "paired-chat/1", pairing: live ? ready : { status: "waiting" } as never,
  dataLink: live ? "open" : "idle", sessionOffers: { mine: ["apps/1"], peer: live ? ["apps/1"] : null }, capabilities: { files: true, payments: false } });

/** The state as the engine sends it after a change elsewhere: the same content, every object new. */
const sentAgain = (patch: StatePatch = {}) => act(() => fakeEngine.setState({ ...structuredClone(fakeEngine.state), ...patch } as StatePatch));

beforeEach(() => {
  forgetAppsAvailable();
  forgetInstalledApps();
  vi.stubEnv("VITE_APPS_TEST", "1");
  fakeEngine.appRunner = "/app-frame.html";
  setAppOpener(vi.fn(async () => {}));
  fakeEngine.on("appList", () => []);
});
afterEach(() => {
  vi.unstubAllEnvs();
  setAppOpener(null);
});

async function setUp(cards: number) {
  fakeEngine.setState({ links: [ana(false)] });
  let draws = 0;
  renderApp(<Profiler id="chat" onRender={() => { draws++; }}>
    {Array.from({ length: cards }, (_, i) => <MessageBubble key={i} message={cardMessage(`m${i}`)} peerPubKey="peer" contactName="Ana" linkId="link-1" />)}
  </Profiler>);
  expect(await screen.findAllByTestId("app-card")).toHaveLength(cards);
  expect(screen.getAllByTestId("app-card-waiting")[0]).toHaveTextContent("Chess needs you both online");
  // What the page still settles after its first draw (the installed list read) is not counted.
  await act(async () => {});
  return () => draws;
}

describe("app cards in a chat on an engine state", () => {
  it("are not drawn again when nothing they show changed", async () => {
    const draws = await setUp(20);
    const before = draws();
    for (let i = 0; i < 5; i++) sentAgain({ transfers: { [`file-${i}`]: { state: "transferring", transferred: i * 1000, size: 10_000 } } });
    expect(draws() - before).toBe(0);
  });

  it("are drawn again when the contact comes online, and say the app can play", async () => {
    const draws = await setUp(3);
    const before = draws();
    sentAgain({ links: [ana(true)] });
    expect(screen.queryByTestId("app-card-waiting")).not.toBeInTheDocument();
    expect(draws() - before).toBeGreaterThanOrEqual(1);
    sentAgain({ links: [ana(false)] });
    expect(screen.getAllByTestId("app-card-waiting")).toHaveLength(3);
  });
});
