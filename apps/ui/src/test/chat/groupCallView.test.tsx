import { act, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupCallView, type GroupCallParticipant, type GroupCallState } from "../../components/GroupCallView";
import type { GroupCallError } from "../../hooks/useGroupCall";
import { FakeTrack } from "../../../../../packages/react/test/fakes";
import { axeViolations } from "../axe";
import { renderApp } from "../render";

/**
 * The group call window, drawn from `useGroupCall`'s state on fake participants: the grid, the active speaker, a shared
 * screen in the main area, the small window, and the buttons.
 */

const video = () => new FakeTrack("video") as unknown as MediaStreamTrack;

function person(identity: string, over: Partial<GroupCallParticipant> = {}): GroupCallParticipant {
  return { identity, name: identity[0].toUpperCase() + identity.slice(1), mic: true, camera: false, screen: false, speaking: false, tracks: {}, ...over };
}

function state(others: number, over: Partial<GroupCallState> = {}): GroupCallState {
  return { local: person("me"), participants: Array.from({ length: others }, (_, i) => person(`p${i}`)), activeSpeaker: null, ...over };
}

function view(call: GroupCallState, props: Partial<Parameters<typeof GroupCallView>[0]> = {}) {
  const handlers = { onToggleMic: vi.fn(), onToggleCamera: vi.fn(), onToggleScreen: vi.fn(), onLeave: vi.fn() };
  const result = renderApp(<GroupCallView call={call} groupName="Community" canShareScreen {...handlers} {...props} />);
  return { ...result, handlers, rerenderWith: (next: GroupCallState) => result.rerender(<GroupCallView call={next} groupName="Community" canShareScreen {...handlers} {...props} />) };
}

const tiles = () => screen.getAllByTestId("group-call-tile");

afterEach(() => localStorage.removeItem("ghostly_group_call_mini"));

describe("the group call grid", () => {
  it.each([[1, 1], [2, 2], [4, 2], [9, 3], [25, 5]])("lays %i tiles out in %i columns, you among them", (count, columns) => {
    view(state(count - 1));
    expect(screen.getByTestId("group-call")).toHaveAttribute("data-count", String(count));
    expect(tiles()).toHaveLength(count);
    expect(screen.getByTestId("group-call-grid").style.gridTemplateColumns).toBe(`repeat(${columns}, minmax(0, 1fr))`);
    expect(tiles()[0]).toHaveTextContent("You");
  });

  it("shows a face without a camera as its avatar and name, and a camera as a picture", () => {
    view(state(0, { participants: [person("ana"), person("bo", { camera: true, tracks: { camera: video() } })] }));
    const [, ana, bo] = tiles();
    expect(ana).toHaveAttribute("data-video", "false");
    expect(ana).toHaveTextContent("AAna");
    expect(bo).toHaveAttribute("data-video", "true");
    expect(bo.querySelector("video")).not.toBeNull();
    expect(bo).toHaveTextContent("Bo");
  });

  it("reads each tile to a screen reader by its name alone, not the avatar's letter before it", () => {
    view(state(0, { participants: [person("ana", { mic: false })] }));
    // The text a screen reader reads: every text node outside an aria-hidden part, and the muted mark by its name.
    const spoken = (el: Element) => {
      const words: string[] = [];
      const walk = (node: Node) => {
        if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return;
        if (node instanceof Element && node.getAttribute("role") === "img") return void words.push(node.getAttribute("aria-label") ?? "");
        if (node.nodeType === Node.TEXT_NODE) words.push(node.textContent ?? "");
        node.childNodes.forEach(walk);
      };
      walk(el);
      return words.filter(Boolean).join(" ");
    };
    const [you, ana] = tiles();
    expect(spoken(you)).toBe("You");
    expect(spoken(ana)).toBe("Muted Ana");
  });

  it("marks who is muted, and rings the active speaker alone", () => {
    const { rerenderWith } = view(state(0, { participants: [person("ana", { mic: false }), person("bo", { speaking: true })], activeSpeaker: "bo" }));
    const byId = (id: string) => tiles().find((t) => t.dataset.identity === id)!;
    expect(within(byId("ana")).getByTestId("group-call-muted")).toHaveAccessibleName("Muted");
    expect(within(byId("bo")).queryByTestId("group-call-muted")).toBeNull();
    expect(tiles().filter((t) => t.dataset.speaking === "true").map((t) => t.dataset.identity)).toEqual(["bo"]);
    expect(byId("bo")).toHaveClass("ring-accent");

    rerenderWith(state(0, { participants: [person("ana", { mic: false }), person("bo")], activeSpeaker: "ana" }));
    expect(tiles().filter((t) => t.dataset.speaking === "true").map((t) => t.dataset.identity)).toEqual(["ana"]);
  });
});

describe("a shared screen", () => {
  it("takes the main area with the faces beside it", () => {
    view(state(0, { participants: [person("ana", { screen: true, tracks: { screen: video() } }), person("bo")] }));
    expect(screen.queryByTestId("group-call-grid")).toBeNull();
    const stage = screen.getByTestId("group-call-stage");
    const main = within(stage).getAllByTestId("group-call-tile")[0];
    expect(main).toHaveAttribute("data-kind", "screen");
    expect(main).toHaveAttribute("data-identity", "ana");
    expect(main).toHaveTextContent("Ana's screen");
    expect(within(screen.getByTestId("group-call-side")).getAllByTestId("group-call-tile").map((t) => t.dataset.identity)).toEqual(["me", "ana", "bo"]);
  });

  it("two at once: the latest wins and the other is a tile; when it stops, the other is back", () => {
    const sharing = (who: string[]) => state(0, { participants: ["ana", "bo"].map((id) => person(id, who.includes(id) ? { screen: true, tracks: { screen: video() } } : {})) });
    const main = () => within(screen.getByTestId("group-call-stage")).getAllByTestId("group-call-tile")[0];
    const sideScreens = () => within(screen.getByTestId("group-call-side")).getAllByTestId("group-call-tile").filter((t) => t.dataset.kind === "screen").map((t) => t.dataset.identity);

    // Bo starts after Ana, though Bo comes later in the list either way: the order is when they started.
    const { rerenderWith } = view(sharing(["bo"]));
    expect(main()).toHaveAttribute("data-identity", "bo");
    rerenderWith(sharing(["ana", "bo"]));
    expect(main()).toHaveAttribute("data-identity", "ana");
    expect(sideScreens()).toEqual(["bo"]);

    rerenderWith(sharing(["bo"]));
    expect(main()).toHaveAttribute("data-identity", "bo");
    expect(sideScreens()).toEqual([]);

    rerenderWith(sharing([]));
    expect(screen.getByTestId("group-call-grid")).toBeInTheDocument();
  });
});

describe("the tiles on a phone's safe areas", () => {
  /** The declarations the stylesheet gives `.call-tiles`, in and out of a phone's media block. */
  const tileRules = () => {
    const css = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(([, selector]) => /^\s*\.call-tiles\s*$/.test(selector)).map(([, , body]) => body.trim());
  };

  it.each([
    ["the grid", state(2)],
    ["the stage", state(0, { participants: [person("ana", { screen: true, tracks: { screen: video() } })] })],
  ])("%s keeps clear of the notch on either side and of the controls over a home bar", (_, call) => {
    view(call);
    const area = screen.getByTestId(call.participants.some((p) => p.screen) ? "group-call-stage" : "group-call-grid");
    expect(area).toHaveClass("call-tiles");
    const rules = tileRules();
    // On its side the notch is on the left or the right: the tiles start 1rem past it.
    expect(rules).toContainEqual(expect.stringMatching(/padding-left:\s*calc\(1rem \+ env\(safe-area-inset-left\)\)/));
    expect(rules).toContainEqual(expect.stringMatching(/padding-right:\s*calc\(1rem \+ env\(safe-area-inset-right\)\)/));
    // Upright, the controls end 2.5rem + 72 px over the home bar: the tiles end 1rem above them.
    expect(rules).toContainEqual(expect.stringMatching(/padding-bottom:\s*calc\(2\.5rem \+ 72px \+ 1rem \+ env\(safe-area-inset-bottom\)\)/));
  });
});

describe("the group call window", () => {
  it("has mic, camera, share screen and leave, named for what they do next", async () => {
    const { user, handlers, rerenderWith } = view(state(2));
    expect(screen.getByTestId("group-call-mic")).toHaveAccessibleName("Mute");
    expect(screen.getByTestId("group-call-camera")).toHaveAccessibleName("Turn camera on");
    expect(screen.getByTestId("group-call-screen")).toHaveAccessibleName("Share screen");
    expect(screen.getByTestId("group-call-leave")).toHaveAccessibleName("Leave call");

    await user.click(screen.getByTestId("group-call-mic"));
    await user.click(screen.getByTestId("group-call-camera"));
    await user.click(screen.getByTestId("group-call-screen"));
    await user.click(screen.getByTestId("group-call-leave"));
    expect([handlers.onToggleMic, handlers.onToggleCamera, handlers.onToggleScreen, handlers.onLeave].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);

    rerenderWith(state(2, { local: person("me", { mic: false, camera: true, screen: true, tracks: { camera: video(), screen: video() } }) }));
    expect(screen.getByTestId("group-call-mic")).toHaveAccessibleName("Unmute");
    expect(screen.getByTestId("group-call-camera")).toHaveAccessibleName("Turn camera off");
    expect(screen.getByTestId("group-call-screen")).toHaveAccessibleName("Stop sharing");
  });

  it("has no share button where no screen can be captured", () => {
    view(state(1), { canShareScreen: false });
    expect(screen.queryByTestId("group-call-screen")).toBeNull();
  });

  it("is a modal dialog named for the group, with the details behind its ⓘ", async () => {
    const { user } = view(state(1));
    expect(screen.getByRole("dialog", { name: "Community" })).toBe(screen.getByTestId("group-call"));
    expect(screen.queryByTestId("group-call-info-text")).toBeNull();
    await user.click(screen.getByTestId("group-call-info"));
    expect(screen.getByTestId("group-call-info-text")).toHaveTextContent("It goes through the group's node.");
    expect(await axeViolations(screen.getByTestId("group-call"))).toEqual([]);
  });

  it("rides in a small window away from the group, showing who speaks, and goes back to it", async () => {
    const onReturnToChat = vi.fn();
    const { user } = view(state(0, { participants: [person("ana"), person("bo")], activeSpeaker: "bo" }), { pinned: true, onReturnToChat });
    const window = screen.getByTestId("group-call");
    expect(window).toHaveAttribute("data-mini", "true");
    expect(window).not.toHaveAttribute("role");
    expect(tiles().map((t) => t.dataset.identity)).toEqual(["bo"]);
    expect(screen.getByTestId("group-call-leave")).toBeInTheDocument();
    await user.click(screen.getByTestId("group-call-minimize"));
    expect(onReturnToChat).toHaveBeenCalledOnce();
  });

  it.each([[false, "whole screen"], [true, "small window"]])("gives the focus back to what opened it when the call is left (pinned %s: %s)", async (pinned) => {
    function Host() {
      const [on, setOn] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOn(true)}>Join call</button>
          {on && <GroupCallView call={state(2)} groupName="Community" canShareScreen pinned={pinned}
            onToggleMic={vi.fn()} onToggleCamera={vi.fn()} onToggleScreen={vi.fn()} onLeave={() => setOn(false)} />}
        </>
      );
    }
    const { user } = renderApp(<Host />);
    const join = screen.getByRole("button", { name: "Join call" });
    await user.click(join);
    if (!pinned) expect(screen.getByTestId("group-call")).toHaveFocus();
    screen.getByTestId("group-call-leave").focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("group-call")).toBeNull();
    expect(join).toHaveFocus();
  });

  it("shrinks into the small window by its button, which shows the shared screen, and grows back", async () => {
    const { user } = view(state(0, { participants: [person("ana", { screen: true, tracks: { screen: video() } }), person("bo")], activeSpeaker: "bo" }));
    await user.click(screen.getByTestId("group-call-minimize"));
    expect(screen.getByTestId("group-call")).toHaveAttribute("data-mini", "true");
    expect(tiles().map((t) => [t.dataset.identity, t.dataset.kind])).toEqual([["ana", "screen"]]);
    await user.click(screen.getByTestId("group-call-minimize"));
    expect(screen.getByTestId("group-call")).toHaveAttribute("data-mini", "false");
  });
});

describe("a mic, camera or screen that did not come on", () => {
  const refused = (name: string) => Object.assign(new Error("Permission denied"), { name });
  const micRefused = (): GroupCallError => ({ action: "mic", message: "Permission denied", cause: refused("NotAllowedError") });
  const withError = (error: GroupCallError | null, props: Partial<Parameters<typeof GroupCallView>[0]> = {}, language?: "pt") => {
    const handlers = { onToggleMic: vi.fn(), onToggleCamera: vi.fn(), onToggleScreen: vi.fn(), onLeave: vi.fn() };
    const draw = (next: GroupCallError | null) => <GroupCallView call={state(2, { local: person("me", { mic: false }) })} groupName="Community" canShareScreen {...handlers} {...props} error={next} />;
    const result = renderApp(draw(error), language && { language });
    return { ...result, setError: (next: GroupCallError | null) => result.rerender(draw(next)) };
  };

  it("says a mic refused at the join as an alert, with where to allow it", async () => {
    withError(micRefused());
    const alert = screen.getByRole("alert");
    expect(alert).toBe(screen.getByTestId("group-call-error"));
    expect(alert).toHaveTextContent("No access to the micAllow access in your browser or system settings.");
    expect(screen.getByRole("dialog", { name: "Community" })).toContainElement(alert);
    expect(await axeViolations(screen.getByTestId("group-call"))).toEqual([]);
  });

  it("says a camera not found, and a screen share refused or not supported, in the 1:1 call's words", () => {
    const { setError } = withError({ action: "camera", message: "Requested device not found", cause: refused("NotFoundError") });
    expect(screen.getByRole("alert")).toHaveTextContent("No camera found, so video is offConnect one, or close the app using it.");
    setError({ action: "screen", message: "Screen sharing is blocked. Allow screen recording for this app in your system's privacy settings.", cause: refused("NotAllowedError") });
    expect(screen.getByRole("alert")).toHaveTextContent("Screen sharing is blocked. Allow screen recording for this app in your system's privacy settings.");
    setError({ action: "screen", message: "Screen sharing is not available here" });
    expect(screen.getByRole("alert")).toHaveTextContent(/^Screen sharing is not available here$/);
  });

  it("says one it does not know as it came, and in the small window too", () => {
    withError({ action: "mic", message: "could not publish the track", cause: new Error("could not publish the track") }, { pinned: true });
    expect(screen.getByTestId("group-call")).toHaveAttribute("data-mini", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/^could not publish the track$/);
  });

  it("is said in the app's language", () => {
    withError(micRefused(), {}, "pt");
    expect(screen.getByRole("alert")).toHaveTextContent("Sem acesso ao microfonePermita o acesso nos ajustes do navegador ou do sistema.");
  });

  it("goes after a few seconds, is said anew at the next failed try, and goes when a try works", () => {
    vi.useFakeTimers();
    try {
      const { setError } = withError(micRefused());
      const first = screen.getByRole("alert");
      act(() => { vi.advanceTimersByTime(7900); });
      expect(screen.getByRole("alert")).toBe(first);
      act(() => { vi.advanceTimersByTime(200); });
      expect(screen.queryByRole("alert")).toBeNull();

      // Pressed again, refused again: the same words, a new alert a screen reader says.
      setError(micRefused());
      const again = screen.getByRole("alert");
      expect(again).toHaveTextContent("No access to the mic");
      setError(micRefused());
      expect(screen.getByRole("alert")).not.toBe(again);

      setError(null);
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing for a failed join: the call's button says that one", () => {
    withError({ action: "join", message: "could not connect" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
