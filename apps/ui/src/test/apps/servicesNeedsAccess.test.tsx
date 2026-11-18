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
    expect(await within(card).findByText("Not allowed in this browser yet: contacts can't open Notes")).toBeTruthy();
    await user.click(within(card).getByTestId("service-allow"));

    expect(asked).toHaveBeenCalledWith("http://localhost/*", "http://localhost:9000");
    await waitFor(() => expect(within(card).queryByTestId("service-allow")).toBeNull());
    expect(within(card).queryByText("Not allowed in this browser yet: contacts can't open Notes")).toBeNull();
  });

  it("says so again once Chrome's site access was taken back and Share is turned on again", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    const allowed = new Set(["http://localhost:9000"]);
    fakeEngine.localAccessAllowed = async (origin) => allowed.has(origin);
    const notes = { id: "notes", name: "Notes", target: "localhost:9000", enabled: true, requests: 0, createdAt: 1, sharedWith: ["p".repeat(52)] };
    renderApp(<Services />, { route: "/services" });
    fakeEngine.update({ services: [notes] });
    const card = await screen.findByTestId("service-item");
    expect(await within(card).findByText("Shared with 1 contact")).toBeTruthy();

    // Site access turned off in chrome://extensions: the extension stops sharing the apps at that host.
    allowed.clear();
    fakeEngine.update({ services: [{ ...notes, enabled: false }] });
    expect(await within(card).findByText("Stopped")).toBeTruthy();
    // Share on again: contacts are refused until the person allows the address here.
    fakeEngine.update({ services: [notes] });

    expect(await within(card).findByText("Not allowed in this browser yet: contacts can't open Notes")).toBeTruthy();
    expect(within(card).getByTestId("service-allow")).toBeTruthy();
    expect(within(card).queryByText("Shared with 1 contact")).toBeNull();
  });

  // Two such apps had two buttons named just "Allow", and the card said neither why the app was asked again, nor what
  // Chrome would be asked for (the whole host, every port), nor how to take it back.
  it("names the app on its Allow, and says what Allow asks for and how to give it back", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    fakeEngine.localAccessAllowed = async () => false;
    renderApp(<Services />, { route: "/services" });
    fakeEngine.update({ services: [
      { id: "notes", name: "Notes", target: "localhost:9000", enabled: true, requests: 0, createdAt: 1, sharedWith: ["p".repeat(52)] },
      { id: "wiki", name: "Wiki", target: "http://127.0.0.1:8080", enabled: true, requests: 0, createdAt: 2, sharedWith: ["p".repeat(52)] },
    ] });

    const allow = await screen.findAllByTestId("service-allow");
    expect(allow.map((b) => b.getAttribute("aria-label"))).toEqual(["Allow Notes", "Allow Wiki"]);
    const [notes] = screen.getAllByTestId("service-item");
    expect(within(notes).getByText("Not allowed in this browser yet: contacts can't open Notes")).toBeTruthy();
    expect(within(notes).getByText("Allow asks your browser for access to localhost, on every port. Removing every app at localhost gives it back.")).toBeTruthy();
    const described = allow[1].getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent).join(" ");
    expect(described).toContain("contacts can't open Wiki");
    expect(described).toContain("access to 127.0.0.1, on every port");
  });

  // A no in Chrome's prompt was dropped: the same card, nothing said, the focus still on Allow.
  it("says a no in the browser's question where Allow was pressed, with what to do next", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    fakeEngine.localAccessAllowed = async () => false;
    const asked = vi.spyOn(fakeEngine, "requestLocalAccess").mockResolvedValue(false);
    const { user } = renderApp(<Services />, { route: "/services" });
    fakeEngine.update({ services: [{ id: "notes", name: "Notes", target: "localhost:9000", enabled: true, requests: 0, createdAt: 1, sharedWith: ["p".repeat(52)] }] });

    const card = await screen.findByTestId("service-item");
    await user.click(await within(card).findByTestId("service-allow"));

    const refused = await within(card).findByRole("alert");
    expect(refused.textContent).toContain("Ghostly needs your permission to reach that local address");
    expect(refused.textContent).toContain("Try again, and choose Allow when you're asked.");
    expect(document.activeElement).toBe(within(card).getByTestId("service-allow"));

    // Allowed on the second try: the notice goes with the button.
    asked.mockResolvedValue(true);
    fakeEngine.localAccessAllowed = async () => true;
    await user.click(within(card).getByTestId("service-allow"));
    await waitFor(() => expect(within(card).queryByTestId("service-allow")).toBeNull());
    expect(within(card).queryByRole("alert")).toBeNull();
  });

  it("shows nothing of it where the host does not ask (the web app, Desktop)", async () => {
    fakeEngine.features = { ...fakeEngine.features, shareLocalServices: true };
    renderApp(<Services />, { route: "/services" });
    fakeEngine.update({ services: [{ id: "notes", name: "Notes", target: "localhost:9000", enabled: true, requests: 0, createdAt: 1 }] });
    await screen.findByTestId("service-item");
    expect(screen.queryByTestId("service-allow")).toBeNull();
  });
});
