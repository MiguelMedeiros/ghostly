import { describe, expect, it, vi } from "vitest";
import { openLayer } from "../../lib/layerHistory";

// covers: app.navigation.back

/*
 * A navigation in the tab (a device code's link pasted in the address bar, or opened by the installed web app) is a
 * popstate. A browser runs the page's microtasks between that popstate's listeners: the router's comes first (it starts
 * listening as the app mounts, before any layer opens), and the page it leads to is drawn before the layers' own listener
 * runs. The layer that page opens (the device code's "Add this device") is not one the person's Back was over: it stays.
 */
describe("a layer opened by the navigation a popstate is", () => {
  it("is not closed by that popstate", async () => {
    // Stands in for the router's listener and the render the browser lets in after it: the link's page closes the name
    // step and opens the join dialog.
    const join = vi.fn();
    let leaveNameStep = () => {};
    const router = () => { window.removeEventListener("popstate", router); leaveNameStep(); openLayer(join); };
    window.addEventListener("popstate", router);

    const nameStep = vi.fn();
    leaveNameStep = openLayer(nameStep);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((history.state as Record<string, unknown>).ghostlyLayer).toBe(1);

    history.pushState(null, "", "#Personal#ghostly1zcode");
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(nameStep).not.toHaveBeenCalled();
    expect(join, "the join dialog stays open").not.toHaveBeenCalled();
    expect((history.state as Record<string, unknown>).ghostlyLayer, "with an entry of its own: Back closes it").toBe(1);
  });
});
