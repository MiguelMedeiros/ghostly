import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServiceView } from "@ghostly/browser/shared/types";
import { Services } from "../../pages/Services";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: services.add, services.stop

/*
 * Share closes the form, Cancel closes it, and Remove takes its card away: each time the control that had the focus
 * went, and the focus fell to the page, where a screen reader loses its place. Nothing said what happened either, and
 * Remove took an app contacts may be using at once, without asking.
 */

afterEach(() => {
  vi.restoreAllMocks();
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false };
});

const app = (id: string, name: string, port: number): ServiceView => ({ id, name, target: `http://localhost:${port}`, enabled: true, requests: 0, createdAt: 1 });

function page(services: ServiceView[] = []) {
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
  vi.spyOn(fakeEngine, "requestLocalAccess").mockResolvedValue(true);
  const view = renderApp(<Services />, { route: "/services" });
  act(() => view.engine.update({ services }));
  return view;
}

const card = (name: string) => screen.getAllByTestId("service-item").find((el) => el.getAttribute("aria-label") === name)!;

describe("the Services page by keyboard", () => {
  it("after Share, gives the focus to the new app's card once it is drawn and says it was added", async () => {
    const { user, engine } = page();
    engine.on("addService", () => ({ serviceId: "atlas" }));
    await user.click(await screen.findByTestId("add-service"));
    await user.type(screen.getByTestId("service-name"), "Atlas");
    await user.type(screen.getByTestId("service-target"), "localhost:3400{Enter}");
    await act(async () => {});
    expect(screen.queryByTestId("service-name")).toBeNull();
    // The engine's state comes after the call's answer.
    act(() => engine.update({ services: [app("atlas", "Atlas", 3400)] }));

    expect(document.activeElement).toBe(card("Atlas"));
    expect(screen.getByTestId("toast-region")).toHaveTextContent("Atlas added. Choose who can open it under People.");
  });

  it("after Cancel, gives the focus back to Share a local service", async () => {
    const { user } = page();
    await user.click(await screen.findByTestId("add-service"));
    await user.type(screen.getByTestId("service-name"), "Atlas");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).toBe(screen.getByTestId("add-service"));
  });

  it("asks before Remove, and Cancel there gives the focus back to Remove", async () => {
    const { user, engine } = page([app("atlas", "Atlas", 3400)]);
    await user.click(await screen.findByRole("button", { name: "Remove Atlas" }));

    const question = screen.getByRole("group", { name: "Remove Atlas?" });
    expect(engine.callsTo("removeService")).toEqual([]);
    expect(document.activeElement).toBe(within(question).getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("group", { name: "Remove Atlas?" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove Atlas" }));
  });

  it("after Remove, gives the focus to the next app's card and says it was removed", async () => {
    const { user, engine } = page([app("atlas", "Atlas", 3400), app("notes", "Notes", 3500)]);
    engine.on("removeService", () => undefined);
    await user.click(await screen.findByRole("button", { name: "Remove Atlas" }));
    await user.click(within(screen.getByRole("group", { name: "Remove Atlas?" })).getByRole("button", { name: "Remove" }));
    expect(engine.callsTo("removeService")).toEqual([{ serviceId: "atlas" }]);
    act(() => engine.update({ services: [app("notes", "Notes", 3500)] }));

    expect(document.activeElement).toBe(card("Notes"));
    expect(screen.getByTestId("toast-region")).toHaveTextContent("Atlas removed.");
  });

  it("after the last app is removed, gives the focus to Share a local service", async () => {
    const { user, engine } = page([app("atlas", "Atlas", 3400)]);
    engine.on("removeService", () => undefined);
    await user.click(await screen.findByRole("button", { name: "Remove Atlas" }));
    await user.click(within(screen.getByRole("group", { name: "Remove Atlas?" })).getByRole("button", { name: "Remove" }));
    act(() => engine.update({ services: [] }));

    expect(document.activeElement).toBe(screen.getByTestId("add-service"));
    expect(screen.getByTestId("toast-region")).toHaveTextContent("Atlas removed.");
  });
});
