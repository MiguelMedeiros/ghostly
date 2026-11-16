import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Services } from "../../pages/Services";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: services.add

/*
 * Share waits for the host's permission (Chrome's prompt in the extension, a native dialog on Desktop) before the app is
 * added. A second Enter or click on Share meanwhile added the same app twice: two "Atlas localhost:3400" cards.
 */

afterEach(() => {
  vi.restoreAllMocks();
  fakeEngine.features = { ...fakeEngine.features, shareLocalServices: false };
  delete fakeEngine.localAccessAllowed;
});

describe("Share on the Services page", () => {
  it("adds the app once when pressed again while the permission is asked", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    let grant!: (granted: boolean) => void;
    const asked = vi.spyOn(fakeEngine, "requestLocalAccess").mockImplementation(() => new Promise<boolean>((done) => { grant = done; }));
    const { user, engine } = renderApp(<Services />, { route: "/services" });
    engine.on("addService", () => ({ serviceId: "atlas" }));
    await user.click(await screen.findByTestId("add-service"));
    await user.type(screen.getByTestId("service-name"), "Atlas");
    await user.type(screen.getByTestId("service-target"), "localhost:3400{Enter}");
    const share = screen.getByTestId("service-save");
    await user.click(share);
    await user.keyboard("{Enter}");
    await act(async () => grant(true));

    expect(asked).toHaveBeenCalledTimes(1);
    expect(engine.callsTo("addService")).toEqual([{ name: "Atlas", target: "localhost:3400" }]);
  });

  // The extension stops an app whose host's site access was taken back in Chrome. Its Share switch turned on again
  // without asking, and its contacts were refused until a second click on the card's Allow.
  it("asks for the app's address again when its Share is turned back on, and says so when the answer is no", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    fakeEngine.localAccessAllowed = async () => false;
    const asked = vi.spyOn(fakeEngine, "requestLocalAccess").mockResolvedValue(false);
    const { user, engine } = renderApp(<Services />, { route: "/services" });
    act(() => engine.update({ services: [{ id: "atlas", name: "Atlas", target: "http://localhost:3400", enabled: false, requests: 0, createdAt: 1 }] }));
    await user.click(await screen.findByRole("switch", { name: "Share Atlas" }));

    expect(asked).toHaveBeenCalledWith("http://localhost/*", "http://localhost:3400");
    expect(engine.callsTo("setServiceEnabled")).toEqual([]);
    expect(await screen.findByText("Ghostly needs your permission to reach that local address")).toBeInTheDocument();
  });
});
