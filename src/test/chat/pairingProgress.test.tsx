import { act, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LinkView } from "@ghostly/browser/shared/types";
import { PairingIndicator } from "../../components/pairing/PairingIndicator";
import { PairingScene } from "../../components/pairing/PairingScene";
import { CELEBRATE_MS, usePairingProgress } from "../../hooks/usePairingProgress";
import { deriveStage, failureReason, formatElapsed, type PairingProgress } from "../../lib/pairingProgress";
import { loadSettings, saveSettings } from "../../lib/settings";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// The sounds module plays through Web Audio, which happy-dom has not: the test hears what is asked of it.
const { playSound } = vi.hoisted(() => ({ playSound: vi.fn((_name: string) => () => {}) }));
vi.mock("../../lib/sounds", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/sounds")>()), playSound }));

// covers: chat.paired.pairing-progress, chat.one-chat, app.attention.sounds

type Pairing = NonNullable<LinkView["pairing"]>;
const pairing = (patch: Partial<Pairing>) => patch as Pairing;

/** Chat.tsx's use of the scene, without the rest of the chat. */
function Pairing({ inviter = true, createdAt, muted }: { inviter?: boolean; createdAt?: number; muted?: boolean }) {
  const p = usePairingProgress("peer", { inviter, enabled: true, createdAt, muted });
  if (!p.show || !p.progress) return <p>the chat</p>;
  return <>
    <PairingIndicator progress={p.progress} />
    <PairingScene progress={p.progress} contact="Alice" retry={() => void p.retry()} retrying={p.retrying} retryError={p.retryError} />
  </>;
}

// A link in each state the engine shows before the contract field lands, from a fresh invite to live.
const fresh = { dataLink: "idle", peerOnline: false, status: "connecting", pairing: pairing({ status: "connecting" }) } as Partial<LinkView>;
const published = { ...fresh, status: "online" } as Partial<LinkView>;
const knocked = { ...published, peerOnline: true } as Partial<LinkView>;
const signaling = { ...knocked, dataLink: "answering" } as Partial<LinkView>;
const connecting = { ...knocked, dataLink: "connecting", pairing: pairing({ status: "negotiating", peerKey: "p" }) } as Partial<LinkView>;
const live = { ...knocked, dataLink: "open", pairing: pairing({ status: "ready", transport: "webrtc/1", peerKey: "p" }), peerParticipationKey: "p" } as Partial<LinkView>;

function show(link: Partial<LinkView>, engine: ReturnType<typeof renderApp>["engine"]) {
  act(() => engine.update({ links: [linkView({ createdAt: Date.now(), ...link })] }));
}
const label = () => screen.getByTestId("pairing-stage-label").textContent;
const currentStep = () => screen.getByTestId("pairing-steps").querySelector("[aria-current=step]")?.getAttribute("data-step");
const scene = () => screen.queryByTestId("pairing-scene");

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); playSound.mockClear(); });

describe("the stage, read off today's link fields", () => {
  it.each<[string, Partial<LinkView> | undefined, "inviter" | "joiner", string]>([
    ["no link yet, inviter", undefined, "inviter", "publishing"],
    ["no link yet, joiner", undefined, "joiner", "resolving"],
    ["first poll pending, inviter", fresh, "inviter", "publishing"],
    ["published, nobody yet", published, "inviter", "waiting"],
    ["the contact's packet seen by the inviter", knocked, "inviter", "answering"],
    ["looking up the invite", published, "joiner", "resolving"],
    ["the inviter's packet seen by the joiner", knocked, "joiner", "knocking"],
    ["signals being exchanged", signaling, "joiner", "answering"],
    ["the channel opening", connecting, "inviter", "connecting"],
    ["ready and open", live, "joiner", "live"],
  ])("%s", (_, link, role, stage) => {
    expect(deriveStage(link && linkView(link), role, true).stage).toBe(stage);
  });

  it("fails with a reason: offline, a pairing error, a key that changed", () => {
    expect(deriveStage(linkView(live), "joiner", false)).toMatchObject({ stage: "failed", reason: "offline", retryable: false });
    expect(deriveStage(linkView({ ...knocked, pairing: pairing({ status: "error", error: "ICE failed" }) }), "joiner", true))
      .toMatchObject({ stage: "failed", reason: "transport", retryable: true, detail: "ICE failed" });
    expect(deriveStage(linkView({ ...knocked, pairing: pairing({ status: "confirm", keyMismatch: true }) }), "joiner", true))
      .toMatchObject({ stage: "failed", reason: "key-mismatch", retryable: false });
    // Discovery errors are slow stages, not failures: the engine retries discovery by itself.
    expect(deriveStage(linkView({ ...published, discoveryError: "Could not publish discovery: relay down" }), "inviter", true))
      .toMatchObject({ stage: "publishing", detail: "Could not publish discovery: relay down" });
    expect(deriveStage(linkView({ ...published, discoveryError: "Could not read discovery: timeout" }), "joiner", true))
      .toMatchObject({ stage: "resolving", detail: "Could not read discovery: timeout" });
  });

  it("names reasons it knows, in either spelling, and the rest as unknown; times as m:ss", () => {
    expect(failureReason("key-mismatch")).toBe("keyMismatch");
    expect(failureReason("timeout")).toBe("timeout");
    expect(failureReason("gremlins")).toBe("unknown");
    expect(failureReason(undefined)).toBe("unknown");
    expect([0, 9_400, 75_000, 3_725_000].map(formatElapsed)).toEqual(["0:00", "0:09", "1:15", "1:02:05"]);
  });
});

describe("the inviter's scene", () => {
  it("walks from publishing to live, then leaves the chat to itself", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engine } = renderApp(<Pairing inviter />);
    const seen: [string | null, string | null | undefined, string | undefined][] = [];
    for (const link of [fresh, published, knocked, connecting, live]) {
      show(link, engine);
      seen.push([label(), currentStep(), scene()!.dataset.stage]);
    }
    expect(seen).toEqual([
      ["Putting your invite on the network…", "publishing", "publishing"],
      ["Waiting for your contact to open the invite", "waiting", "waiting"],
      ["Your contact knocked. Answering…", "answering", "answering"],
      ["Opening a direct, encrypted link…", "connecting", "connecting"],
      ["Connected", undefined, "live"],
    ]);
    expect(screen.getByText("You can chat now. Say hello!")).toBeInTheDocument();
    expect(screen.getByTestId("pairing-announcement")).toHaveTextContent("Connected");
    act(() => vi.advanceTimersByTime(CELEBRATE_MS - 300));
    expect(scene()).toHaveAttribute("data-leaving");
    act(() => vi.advanceTimersByTime(400));
    expect(scene()).toBeNull();
    expect(screen.getByText("the chat")).toBeInTheDocument();
  });

  it("stays the inviter once the invite code is forgotten", () => {
    const { engine, rerender } = renderApp(<Pairing inviter />);
    show(knocked, engine);
    rerender(<Pairing inviter={false} />);
    expect(label()).toBe("Your contact knocked. Answering…");
    expect([...screen.getByTestId("pairing-steps").querySelectorAll("li")].map(li => li.dataset.step))
      .toEqual(["publishing", "waiting", "answering", "connecting", "live"]);
  });

  it("says in words when the invite has waited long, and how long", () => {
    const { engine } = renderApp(<Pairing inviter />);
    show({ ...published, createdAt: Date.now() - 125_000 }, engine);
    expect(screen.getByTestId("pairing-elapsed")).toHaveTextContent(/^2:0\d$/);
    expect(screen.getByTestId("pairing-slow")).toHaveTextContent("Your contact has not opened the invite yet");
    expect(screen.getByTestId("pairing-announcement")).toHaveTextContent("Your contact has not opened the invite yet");
  });

  it("an invite the relays refuse is a slow publish with the relay's error, not a failure", () => {
    const { engine } = renderApp(<Pairing inviter />);
    show({ ...published, createdAt: Date.now() - 9_000, discoveryError: "Could not publish discovery: 429" }, engine);
    expect(label()).toBe("Putting your invite on the network…");
    expect(screen.getByTestId("pairing-slow")).toHaveTextContent("Still publishing your invite.");
    expect(screen.getByTestId("pairing-detail")).toHaveTextContent("Could not publish discovery: 429");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is not a slow wait a few seconds in", () => {
    const { engine } = renderApp(<Pairing inviter />);
    show(published, engine);
    expect(screen.queryByTestId("pairing-slow")).toBeNull();
  });
});

describe("the joiner's scene", () => {
  it("walks from the lookup to live, the mirror story", () => {
    const { engine } = renderApp(<Pairing inviter={false} />);
    const seen: (string | null)[] = [];
    for (const link of [published, knocked, signaling, connecting, live]) { show(link, engine); seen.push(label()); }
    expect(seen).toEqual([
      "Looking up the invite on the network…",
      "Knocking on your contact's door…",
      "Your contact is answering…",
      "Opening a direct, encrypted link…",
      "Connected",
    ]);
  });

  it("shows the steps done, the current one marked, the names under the ghosts", () => {
    const { engine } = renderApp(<Pairing inviter={false} />);
    show(signaling, engine);
    const steps = [...screen.getByTestId("pairing-steps").querySelectorAll("li")].map(li => [li.dataset.step, li.dataset.state]);
    expect(steps).toEqual([["resolving", "done"], ["knocking", "done"], ["answering", "current"], ["connecting", "todo"], ["live", "todo"]]);
    expect(within(scene()!).getByText("You")).toBeInTheDocument();
    expect(within(scene()!).getByText("Alice")).toBeInTheDocument();
  });

  it("says it is still looking once the lookup takes long", () => {
    const { engine } = renderApp(<Pairing inviter={false} />);
    show({ ...published, createdAt: Date.now() - 15_000 }, engine);
    expect(screen.getByTestId("pairing-slow")).toHaveTextContent("Still looking for your contact on the network…");
  });
});

describe("which chats get the scene", () => {
  // An existing chat opens with its link already in the engine's state.
  const opened = (link: Partial<LinkView>, inviter: boolean) => {
    fakeEngine.update({ links: [linkView({ createdAt: Date.now() - 86_400_000, ...link })] });
    return renderApp(<Pairing inviter={inviter} />);
  };

  it("not one already paired: its reconnects belong to the header's connection control", () => {
    const { engine } = opened({ ...connecting, peerParticipationKey: "p" }, false);
    expect(scene()).toBeNull();
    show({ ...fresh, peerParticipationKey: "p" }, engine);
    expect(scene()).toBeNull();
  });

  it("not one that is live when opened", () => {
    opened({ ...live, peerParticipationKey: undefined }, true);
    expect(scene()).toBeNull();
  });

  it("a chat just joined, before its link is there", () => {
    renderApp(<Pairing inviter={false} createdAt={Date.now()} />);
    expect(label()).toBe("Looking up the invite on the network…");
  });

  it("a chat just joined keeps its scene when the link arrives already pinned by a fast handshake", () => {
    const { engine } = renderApp(<Pairing inviter={false} createdAt={Date.now()} />);
    show({ ...connecting, peerParticipationKey: "p" }, engine);
    expect(label()).toBe("Opening a direct, encrypted link…");
    show(live, engine);
    expect(label()).toBe("Connected");
  });

  it("not an old chat whose link is missing", () => {
    renderApp(<Pairing inviter={false} createdAt={Date.now() - 2 * 3600_000} />);
    expect(scene()).toBeNull();
  });
});

describe("the engine's own report (the pairing-progress contract)", () => {
  const report = (patch: Partial<PairingProgress>): Partial<LinkView> =>
    ({ ...published, pairingProgress: { role: "joiner", stage: "knocking", since: Date.now(), startedAt: Date.now(), attempt: 1, ...patch } } as Partial<LinkView>);

  it("wins over what the link's fields suggest, with its times and attempt", () => {
    const { engine } = renderApp(<Pairing inviter />);
    show(report({ since: Date.now() - 20_000, attempt: 2 }), engine);
    expect(label()).toBe("Knocking on your contact's door…");
    expect(screen.getByTestId("pairing-elapsed")).toHaveTextContent("0:20 · attempt 2");
    expect(screen.getByTestId("pairing-slow")).toHaveTextContent("Your contact's app has not answered yet");
  });

  it("a retryable failure: its reason in words, the detail, and Retry that asks the engine to connect", async () => {
    const { engine, user } = renderApp(<Pairing inviter />);
    engine.on("connect", () => undefined);
    show(report({ stage: "failed", reason: "timeout", retryable: true, detail: "no answer after 30 s" }), engine);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Your contact's app did not answer in time.");
    expect(alert).toHaveTextContent("no answer after 30 s");
    expect(screen.getByTestId("pairing-indicator-tip")).toHaveTextContent("Your contact's app did not answer in time.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(engine.callsTo("connect")).toEqual([{ linkId: "link-1" }]);
  });

  it("a failed retry says why", async () => {
    const { engine, user } = renderApp(<Pairing inviter />);
    engine.on("connect", () => { throw new Error("Relay refused"); });
    show(report({ stage: "failed", reason: "transport", retryable: true }), engine);
    await user.click(screen.getByTestId("pairing-retry"));
    expect(await screen.findByText("Relay refused")).toBeInTheDocument();
  });

  it("a failure retrying cannot fix: no Retry, ask for a new invite", () => {
    const { engine } = renderApp(<Pairing inviter />);
    show(report({ stage: "failed", reason: "expired" as PairingProgress["reason"], retryable: false }), engine);
    expect(screen.getByRole("alert")).toHaveTextContent("This invite has expired.");
    expect(screen.getByRole("alert")).toHaveTextContent("Ask your contact for a new invite.");
    expect(screen.queryByTestId("pairing-retry")).toBeNull();
  });

  it("offline: says so, with neither Retry nor a new invite to ask for", () => {
    const { engine } = renderApp(<Pairing inviter />);
    act(() => engine.update({ settings: { online: false } }));
    show(published, engine);
    expect(screen.getByRole("alert")).toHaveTextContent("You are offline. Pairing goes on once you are back online.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("new invite");
    expect(screen.queryByTestId("pairing-retry")).toBeNull();
  });

  it("an unknown reason reads as something went wrong, with the engine's detail", () => {
    const { engine } = renderApp(<Pairing inviter />);
    show(report({ stage: "failed", reason: "gremlins" as PairingProgress["reason"], retryable: true, detail: "E_GREMLIN" }), engine);
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong while connecting.");
    expect(screen.getByRole("alert")).toHaveTextContent("E_GREMLIN");
  });
});

describe("the header indicator", () => {
  it("names the stage, and its tooltip the sentence and the time", () => {
    const { engine } = renderApp(<Pairing inviter={false} />);
    show({ ...knocked, createdAt: Date.now() - 3_000 }, engine);
    const indicator = screen.getByTestId("pairing-indicator");
    expect(indicator).toHaveAccessibleName("Pairing: Knocking on your contact's door…");
    expect(indicator).toHaveAttribute("data-stage", "knocking");
    expect(screen.getByTestId("pairing-indicator-tip")).toHaveTextContent(/^Knocking on your contact's door… · 0:0\d$/);
  });

  it("opens the scene on click", async () => {
    const onOpen = vi.fn();
    const { user } = renderApp(<PairingIndicator onOpen={onOpen} progress={{ role: "inviter", stage: "waiting", since: Date.now(), startedAt: Date.now(), attempt: 1, derived: true }} />);
    await user.click(screen.getByTestId("pairing-indicator"));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("a pairing that ends on the DHT (WISP 400)", () => {
  /** Chat.tsx's split: the indicator while `show`, the scene only while `scene`. */
  function Chat() {
    const p = usePairingProgress("peer", { inviter: false, enabled: true, createdAt: Date.now() });
    return <>
      {p.show && p.progress && <PairingIndicator progress={p.progress} />}
      {p.scene && p.progress ? <PairingScene progress={p.progress} contact="Alice" retry={() => {}} retrying={false} retryError="" /> : <p>the chat</p>}
    </>;
  }
  const onDht = (reason: string) => ({ ...published, pairingProgress: { role: "joiner", stage: "on-dht", reason, retryable: reason !== "chosen", since: Date.now(), startedAt: Date.now(), attempt: 2 } } as Partial<LinkView>);

  it("is no failure: the chat takes over, and the header says it is on the DHT while live is retried", () => {
    const { engine } = renderApp(<Chat />);
    show(onDht("transport"), engine);
    expect(scene()).toBeNull();
    expect(screen.getByText("the chat")).toBeInTheDocument();
    const indicator = screen.getByTestId("pairing-indicator");
    expect(indicator).toHaveAttribute("data-stage", "on-dht");
    expect(indicator).toHaveTextContent("On DHT · retrying live");
    expect(screen.getByTestId("pairing-indicator-tip")).toHaveTextContent("No live link came up yet. It is retried in the background.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says why: no common transport, DHT only chosen, or still trying", () => {
    const { engine } = renderApp(<Chat />);
    for (const [reason, words] of [["no-common-transport", "share no live transport"], ["chosen", "DHT only was chosen"], ["waiting", "being tried in the background"]]) {
      show(onDht(reason), engine);
      expect(screen.getByTestId("pairing-indicator-tip")).toHaveTextContent(words);
    }
  });
});

describe("the connected sound", () => {
  const sounds = () => playSound.mock.calls.map(([name]) => name);
  const walk = (engine: ReturnType<typeof renderApp>["engine"]) => { for (const link of [fresh, published, knocked, connecting]) show(link, engine); };

  it("plays once, in the same change that starts the connected moment, and never during the waiting stages", () => {
    const { engine } = renderApp(<Pairing inviter />);
    walk(engine);
    expect(sounds()).toEqual([]);
    show(live, engine);
    expect(scene()).toHaveAttribute("data-stage", "live");
    expect(sounds()).toEqual(["connected"]);
  });

  it("not again when the first pairing drops and comes back, during the moment or after it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const { engine } = renderApp(<Pairing inviter={false} />);
    walk(engine);
    show(live, engine);
    show(connecting, engine);
    show(live, engine);
    act(() => vi.advanceTimersByTime(CELEBRATE_MS + 100));
    show(connecting, engine);
    show(live, engine);
    expect(sounds()).toEqual(["connected"]);
  });

  it("not for a transport switch: the link goes over another transport, the pairing stays live", () => {
    const { engine } = renderApp(<Pairing inviter />);
    walk(engine);
    show(live, engine);
    show({ ...live, dataLink: "connecting", pairing: pairing({ status: "negotiating", transport: "iroh/1", peerKey: "p" }) }, engine);
    show({ ...live, pairing: pairing({ status: "ready", transport: "iroh/1", peerKey: "p" }) }, engine);
    expect(sounds()).toEqual(["connected"]);
  });

  it("not for a reconnect of a contact already paired", () => {
    fakeEngine.update({ links: [linkView({ createdAt: Date.now() - 86_400_000, ...connecting, peerParticipationKey: "p" })] });
    const { engine } = renderApp(<Pairing inviter={false} />);
    show({ ...fresh, peerParticipationKey: "p" }, engine);
    show(live, engine);
    expect(sounds()).toEqual([]);
  });

  it("not after a restart: live when the chat opens, nor when that link drops and comes back", () => {
    fakeEngine.update({ links: [linkView({ createdAt: Date.now() - 60_000, ...live, peerParticipationKey: undefined })] });
    const { engine } = renderApp(<Pairing inviter />);
    show({ ...connecting, peerParticipationKey: undefined }, engine);
    show({ ...live, peerParticipationKey: undefined }, engine);
    expect(sounds()).toEqual([]);
    expect(scene()).toBeNull();
  });

  it("not for a pairing that ends on the DHT; its first live link, if one comes up later, is the connected moment", () => {
    const { engine } = renderApp(<Pairing inviter={false} createdAt={Date.now()} />);
    const report = (stage: PairingProgress["stage"]) => ({ ...published, pairingProgress: { role: "joiner", stage, reason: stage === "on-dht" ? "transport" : undefined, since: Date.now(), startedAt: Date.now(), attempt: 2 } } as Partial<LinkView>);
    show(report("on-dht"), engine);
    expect(sounds()).toEqual([]);
    show(report("live"), engine);
    expect(scene()).toHaveAttribute("data-stage", "live");
    expect(sounds()).toEqual(["connected"]);
  });

  it("from the engine's own report too", () => {
    const { engine } = renderApp(<Pairing inviter={false} />);
    const report = (stage: PairingProgress["stage"]) => ({ ...published, pairingProgress: { role: "joiner", stage, since: Date.now(), startedAt: Date.now(), attempt: 1 } } as Partial<LinkView>);
    show(report("knocking"), engine);
    show(report("connecting"), engine);
    show(report("live"), engine);
    expect(sounds()).toEqual(["connected"]);
  });

  it("not with sounds off, nor in a chat whose sounds are muted; the moment itself still comes", () => {
    saveSettings({ ...loadSettings(), notifications: { ...loadSettings().notifications, soundEnabled: false } });
    const off = renderApp(<Pairing inviter />);
    walk(off.engine);
    show(live, off.engine);
    expect(scene()).toHaveAttribute("data-stage", "live");
    off.unmount();
    saveSettings({ ...loadSettings(), notifications: { ...loadSettings().notifications, soundEnabled: true } });
    fakeEngine.reset();
    const muted = renderApp(<Pairing inviter muted />);
    walk(muted.engine);
    show(live, muted.engine);
    expect(scene()).toHaveAttribute("data-stage", "live");
    expect(sounds()).toEqual([]);
  });

  it("with reduced motion: the scene is still, the sound follows the sound setting", () => {
    document.documentElement.dataset.reduceMotion = "true";
    const { engine } = renderApp(<Pairing inviter={false} />);
    walk(engine);
    show(live, engine);
    expect(sounds()).toEqual(["connected"]);
  });
});

describe("motion", () => {
  it("pauses while the scene is off screen", () => {
    let callback: (entries: { isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal("IntersectionObserver", class { constructor(cb: typeof callback) { callback = cb; } observe() {} disconnect() {} });
    const { engine } = renderApp(<Pairing inviter />);
    show(published, engine);
    act(() => callback([{ isIntersecting: false }]));
    expect(scene()).toHaveAttribute("data-paused");
    act(() => callback([{ isIntersecting: true }]));
    expect(scene()).not.toHaveAttribute("data-paused");
  });

  it("with reduced motion, every stage still says the same in words and steps", () => {
    document.documentElement.dataset.reduceMotion = "true";
    const { engine } = renderApp(<Pairing inviter={false} />);
    show(knocked, engine);
    expect(label()).toBe("Knocking on your contact's door…");
    expect(currentStep()).toBe("knocking");
    // The still picture keeps the stage's routes, drawn with arrowheads.
    expect(scene()!.querySelector(".ps-route-up")?.getAttribute("marker-end")).toMatch(/^url\(#ps-arrow-/);
  });

  it("the stylesheet stops every animation under either reduced-motion switch, and shows the routes instead", () => {
    const css = readFileSync(join(fileURLToPath(import.meta.url), "../../../components/pairing/pairing-scene.css"), "utf8");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ps, \.ps \* \{ animation: none !important;/);
    expect(css).toMatch(/:root\[data-reduce-motion="true"\] \.ps, :root\[data-reduce-motion="true"\] \.ps \* \{ animation: none !important;/);
    expect(css).toMatch(/:root\[data-reduce-motion="true"\] \.ps\[data-stage="knocking"\] :is\(\.ps-route-up, \.ps-route-low\)/);
    expect(css).toMatch(/\.ps\[data-paused\] \*, \.ps\[data-paused\] \{ animation-play-state: paused !important; \}/);
  });
});

describe("languages", () => {
  it("speaks the app's language", () => {
    const { engine } = renderApp(<Pairing inviter />, { language: "pt" });
    show(published, engine);
    expect(label()).toBe("Esperando seu contato abrir o convite");
    expect(screen.getByTestId("pairing-steps")).toHaveAccessibleName("Etapas do pareamento");
  });
});
