import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Services } from "../../pages/Services";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// The Services page's header control is Ghostly's own network switch: off, every chat goes offline.
describe("the Services page's online control", () => {
  afterEach(() => { fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false }; });

  it("on the web, where nothing is shared, is a switch named for Ghostly whose hint says every chat disconnects", async () => {
    const view = renderApp(<Services />);
    view.engine.on("updateSettings", () => undefined);
    const toggle = await screen.findByRole("switch", { name: "Ghostly online" });
    expect(toggle).toHaveAttribute("data-testid", "online-toggle");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveAttribute("title", "Turning this off disconnects every chat");
    expect(toggle.title).not.toMatch(/share/i);

    await view.user.click(toggle);
    expect(view.engine.callsTo("updateSettings")).toEqual([{ settings: { online: false } }]);
  });

  it("reads as off once Ghostly is offline, keeping its name", async () => {
    const view = renderApp(<Services />);
    act(() => view.engine.update({ settings: { ...view.engine.state.settings, online: false } }));
    const toggle = await screen.findByRole("switch", { name: "Ghostly online" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("title", "Go online");
  });

  it("where apps are shared, keeps its words about shares and says its state as a switch", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    renderApp(<Services />);
    const toggle = await screen.findByTestId("online-toggle");
    expect(toggle).toHaveAttribute("role", "switch");
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toHaveTextContent(/^Online$/);
    expect(toggle).toHaveAttribute("title", "Go offline: nothing you share stays reachable");
  });

  it("reads in the app's language", async () => {
    renderApp(<Services />, { language: "pt" });
    expect(await screen.findByRole("switch", { name: "Ghostly online" })).toHaveAttribute("title", "Desligar isto desconecta todas as conversas");
  });
});
