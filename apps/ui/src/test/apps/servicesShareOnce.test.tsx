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
});
