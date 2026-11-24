import { act, screen, waitFor } from "@testing-library/react";
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
    expect(await screen.findByText("Not allowed in this browser yet: contacts can't open Atlas")).toBeInTheDocument();
  });

  // An app's name reaches every contact it is shared with, as a group's name its members: one that looks like a recovery
  // phrase asks first (SecretGuardDialog), as a new group's name does, and goes only on "Send anyway".
  it("asks first when the app's name looks like a recovery phrase", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    vi.spyOn(fakeEngine, "requestLocalAccess").mockResolvedValue(true);
    const { user, engine } = renderApp(<Services />, { route: "/services" });
    engine.on("addService", () => ({ serviceId: "act-add" }));
    const phrase = "act add age aim air all any arm art ask bag bar";
    await user.click(await screen.findByTestId("add-service"));
    await user.click(screen.getByTestId("service-name"));
    await user.paste(phrase);
    await user.type(screen.getByTestId("service-target"), "localhost:3400{Enter}");
    expect(await screen.findByTestId("secret-guard")).toHaveAttribute("data-kind", "mnemonic");
    expect(engine.callsTo("addService")).toEqual([]);
    await user.click(screen.getByTestId("secret-guard-cancel"));
    expect(screen.queryByTestId("secret-guard")).not.toBeInTheDocument();
    expect(engine.callsTo("addService")).toEqual([]);
    expect(screen.getByTestId("service-name")).toHaveValue(phrase);
    await user.click(screen.getByTestId("service-save"));
    await user.click(await screen.findByTestId("secret-guard-send"));
    await waitFor(() => expect(engine.callsTo("addService")).toEqual([{ name: phrase, target: "localhost:3400" }]));
  });

  it("says what to do after a no to the permission the form's Share asked", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    vi.spyOn(fakeEngine, "requestLocalAccess").mockResolvedValue(false);
    const { user } = renderApp(<Services />, { route: "/services" });
    await user.click(await screen.findByTestId("add-service"));
    await user.type(screen.getByTestId("service-name"), "Atlas");
    await user.type(screen.getByTestId("service-target"), "localhost:3400{Enter}");

    expect((await screen.findByRole("alert")).textContent).toBe("Ghostly needs your permission to reach that local address. Try again, and choose Allow when you're asked.");
  });
});
