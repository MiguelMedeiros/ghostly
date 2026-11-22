import { afterEach, expect, it, vi } from "vitest";
import { createProfile, switchProfile } from "../../lib/profiles";
import { dropIncomingShare, receiveShare } from "../../lib/incomingShare";

// covers: app.pwa.share-target

/*
 * A share waiting in the web app's Share to… picker goes along with a profile switch (`switchProfile`): the worker
 * holds it again, and hands it over only to a page opened on the picker (`askForShare`). A switch that names its own
 * route (a tapped wake-up notice of another profile's chat, a new profile's page) still opens on the picker.
 */

afterEach(() => {
  dropIncomingShare();
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
  location.hash = "";
});

/** The switch's overlay frame, then the page restarts (here: it goes). Returns where the next page opens. */
function switchTo(id: string, route?: string): string {
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  switchProfile(id, route === undefined ? {} : { route });
  vi.runAllTimers();
  expect(reload).toHaveBeenCalledOnce();
  return location.hash;
}

it.each([
  ["a tapped notice of the other profile's chat", "/chat/s_ana"],
  ["a new profile's page", "/profile"],
  ["the app's home", "/"],
])("a share waiting in the picker opens the other profile on its picker, even through %s", (_how, route) => {
  createProfile("A");
  const b = createProfile("B");
  const carry = vi.fn(() => true);
  receiveShare({ title: "", text: "for Ana", url: "", files: [], carry });
  location.hash = "#/shared";

  expect(switchTo(b.id, route)).toBe("#/shared");
  expect(carry).toHaveBeenCalledOnce();
});

it("nothing waiting: the route named is where the other profile opens", () => {
  createProfile("A");
  const b = createProfile("B");
  expect(switchTo(b.id, "/chat/s_ana")).toBe("#/chat/s_ana");
});
