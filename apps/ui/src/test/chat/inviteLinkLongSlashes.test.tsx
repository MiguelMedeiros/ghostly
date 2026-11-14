import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { takeDeviceLink, takeDeviceLinkFromAddress } from "../../lib/devices";
import { inviteRouteCode } from "../../lib/url";

// covers: invite.link

/*
 * Any address opens the app, and a link anyone sends may hold a long run of `/` that does not end it. Reading the `/`s a
 * link ends with took the square of that run (`/\/+$/`, a lazy code before `\/*$`): 100,000 of them froze the tab for
 * seconds at each read, before anything was drawn and again on the route, with the address left as it was.
 */

const RUN = "/".repeat(100_000);

afterEach(() => { window.location.hash = ""; takeDeviceLink(); });

it("an invite route with a long run of `/` before more is read at once, and refused", () => {
  const started = performance.now();
  expect(inviteRouteCode(`/ghostly1${RUN}x`)).toBe(`ghostly1${RUN}x`);
  expect(inviteRouteCode(`/ghostly1abc${RUN}`)).toBe("ghostly1abc");
  expect(performance.now() - started).toBeLessThan(1_000);
});

it("an address with a long run of `/` before more is passed over at once when the app starts", () => {
  window.history.replaceState(null, "", `#/x${RUN}x`);
  const started = performance.now();
  takeDeviceLinkFromAddress();
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(takeDeviceLink()).toBeFalsy();
});

it.each([`#/ghostly1${RUN}x`, `#/Ana#${RUN}x`])("the open app reads such an address at once, and it leaves the address (%#)", async (form) => {
  render(<Root />);
  const started = performance.now();
  window.location.hash = form;
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  expect(performance.now() - started).toBeLessThan(1_000);
  if (form.includes("ghostly1")) expect(await screen.findByTestId("invite-link-invalid")).toBeInTheDocument();
}, 60_000);
