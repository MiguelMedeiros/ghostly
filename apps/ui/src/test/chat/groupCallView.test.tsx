import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupCallView, type GroupCallParticipant, type GroupCallState } from "../../components/GroupCallView";
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

  it("shrinks into the small window by its button, which shows the shared screen, and grows back", async () => {
    const { user } = view(state(0, { participants: [person("ana", { screen: true, tracks: { screen: video() } }), person("bo")], activeSpeaker: "bo" }));
    await user.click(screen.getByTestId("group-call-minimize"));
    expect(screen.getByTestId("group-call")).toHaveAttribute("data-mini", "true");
    expect(tiles().map((t) => [t.dataset.identity, t.dataset.kind])).toEqual([["ana", "screen"]]);
    await user.click(screen.getByTestId("group-call-minimize"));
    expect(screen.getByTestId("group-call")).toHaveAttribute("data-mini", "false");
  });
});

describe("what a screen reader hears", () => {
  it("says Connected once in the room, then who joins and leaves, several in one line, and not who speaks or mutes", () => {
    const handlers = { onToggleMic: vi.fn(), onToggleCamera: vi.fn(), onToggleScreen: vi.fn(), onLeave: vi.fn() };
    const draw = (call: GroupCallState, connected: boolean) => <GroupCallView call={call} groupName="Community" connected={connected} {...handlers} />;
    const people = (...ids: string[]) => ids.map((id) => person(id));
    const { rerender } = renderApp(draw(state(0), false));
    const news = () => [...screen.getByRole("status").querySelectorAll("p")].map((p) => p.textContent);
    expect(news()).toEqual([]);

    // The people already there when you get in are not read out one by one.
    rerender(draw(state(0, { participants: people("ana", "bo") }), true));
    expect(news()).toEqual(["Connected"]);

    rerender(draw(state(0, { participants: people("ana", "bo", "cy") }), true));
    expect(news()).toEqual(["Cy joined"]);

    rerender(draw(state(0, { participants: [person("ana", { mic: false }), person("bo", { speaking: true }), person("cy")], activeSpeaker: "bo", local: person("me", { mic: false }) }), true));
    expect(news()).toEqual(["Cy joined"]);

    rerender(draw(state(0, { participants: people("cy", "dee", "eli") }), true));
    expect(news()).toEqual(["Dee, Eli joined", "Ana, Bo left"]);

    rerender(draw(state(0, { participants: people("dee") }), true));
    expect(news()).toEqual(["Cy, Eli left"]);
  });
});
