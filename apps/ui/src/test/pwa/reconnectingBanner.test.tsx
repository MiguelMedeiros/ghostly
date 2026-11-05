import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { engine } from "@ghostly/browser/platform/engine";
import { Root } from "../../Root";
import { fakeEngine } from "../fakeEngine";
// covers: extension.reconnecting

/**
 * An extension tab whose peer went away (the offscreen document restarted) and did not come back at once: the page
 * keeps trying by itself, and says so above the chat list until it is connected again.
 */
afterEach(async () => {
  fakeEngine.refuse = null;
  await engine.connect();
});

describe("the reconnecting notice", () => {
  it("shows from the first failed try to reach the peer again, and goes once the page is connected", async () => {
    render(<Root />);
    const sidebar = await screen.findByTestId("sidebar");
    expect(screen.queryByTestId("reconnecting-banner")).toBeNull();

    fakeEngine.refuse = new Error("The offscreen document did not start");
    fakeEngine.drop();
    // The first try is half a second later; nothing shows before it failed.
    expect(screen.queryByTestId("reconnecting-banner")).toBeNull();
    const banner = await within(sidebar).findByTestId("reconnecting-banner", {}, { timeout: 3000 });
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveTextContent("Reconnecting… · This tab lost Ghostly and keeps trying. New messages show here once it's back.");

    fakeEngine.refuse = null;
    await waitFor(() => expect(screen.queryByTestId("reconnecting-banner")).toBeNull(), { timeout: 3000 });
    expect(engine.reconnecting).toBe(false);
  });
});
