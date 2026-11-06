import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Services } from "../../pages/Services";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: services.add

/*
 * An app that came with a restored or moved profile was never allowed in this browser: the extension refuses its
 * contacts until the person allows its address here. The page says so on its card, and Allow asks from that click.
 */

afterEach(() => {
  vi.restoreAllMocks();
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false };
  delete fakeEngine.localAccessAllowed;
});

describe("a shared app whose address this browser has not allowed", () => {
  it("says it needs the person's permission, and Allow asks for that address", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    const allowed = new Set<string>();
    fakeEngine.localAccessAllowed = async (origin) => allowed.has(origin);
    const asked = vi.spyOn(fakeEngine, "requestLocalAccess").mockImplementation(async (_pattern, origin) => { allowed.add(origin); return true; });
    const { user } = renderApp(<Services />, { route: "/services" });
    fakeEngine.update({ services: [{ id: "notes", name: "Notes", target: "localhost:9000", enabled: true, requests: 0, createdAt: 1, sharedWith: ["p".repeat(52)] }] });

    const card = await screen.findByTestId("service-item");
    expect(await within(card).findByText("Ghostly needs your permission to reach that local address")).toBeTruthy();
    await user.click(within(card).getByTestId("service-allow"));

    expect(asked).toHaveBeenCalledWith("http://localhost/*", "http://localhost:9000");
    await waitFor(() => expect(within(card).queryByTestId("service-allow")).toBeNull());
    expect(within(card).queryByText("Ghostly needs your permission to reach that local address")).toBeNull();
  });

  it("shows nothing of it where the host does not ask (the web app, Desktop)", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    renderApp(<Services />, { route: "/services" });
    fakeEngine.update({ services: [{ id: "notes", name: "Notes", target: "localhost:9000", enabled: true, requests: 0, createdAt: 1 }] });
    await screen.findByTestId("service-item");
    expect(screen.queryByTestId("service-allow")).toBeNull();
  });
});
