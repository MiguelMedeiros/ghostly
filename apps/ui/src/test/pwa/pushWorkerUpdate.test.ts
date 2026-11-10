import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushScope } from "../../../../web/src/sw/policy";

// covers: push.wake.online

/*
 * A profile's push worker (`/push/<profile>/`) is registered once, and no page ever runs in its scope: without the page
 * asking, it keeps the script of the build that registered it until the browser looks again on its own (Chromium: a day
 * after its last look, on a push). The page asks for that build's script at start, so the worker reads what the page
 * shares (an online wake-up, `o`, read as "New message" by a worker from before it).
 */

class FakeRegistration {
  constructor(public scope: string) {}
  update = vi.fn(async () => {});
  pushManager = { getSubscription: vi.fn(async () => null) };
  unregister = vi.fn(async () => true);
}

let registrations: Map<string, FakeRegistration>;

beforeEach(() => {
  vi.resetModules();
  registrations = new Map();
  const container = {
    getRegistration: vi.fn(async (scope: string) => registrations.get(scope)),
    register: vi.fn(),
  };
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  Reflect.deleteProperty(window, "isSecureContext");
});

function pushWorkerOf(profile: string): FakeRegistration {
  const scope = new URL(pushScope(profile), location.origin).href;
  const made = new FakeRegistration(scope);
  registrations.set(scope, made);
  return made;
}

describe("a profile's push worker after a deploy", () => {
  it("the page's start asks the browser for the push worker's script of this build", async () => {
    const ana = pushWorkerOf("ana");
    const { currentPush } = await import("../../../../web/src/pwa/push");
    await currentPush("ana");
    expect(ana.update).toHaveBeenCalledTimes(1);
  });

  it("once per page: a standby's page looking every minute does not fetch the script every minute", async () => {
    const ana = pushWorkerOf("ana");
    const { currentPush } = await import("../../../../web/src/pwa/push");
    await currentPush("ana");
    await currentPush("ana");
    await currentPush("ana");
    expect(ana.update).toHaveBeenCalledTimes(1);
  });

  it("each profile's own worker, and only that one", async () => {
    const ana = pushWorkerOf("ana");
    const cat = pushWorkerOf("");
    const { currentPush } = await import("../../../../web/src/pwa/push");
    await currentPush("");
    expect(cat.update).toHaveBeenCalledTimes(1);
    expect(ana.update).not.toHaveBeenCalled();
  });

  it("a script the browser cannot fetch now (offline) changes nothing of what the page reads", async () => {
    const ana = pushWorkerOf("ana");
    ana.update.mockRejectedValue(new TypeError("Failed to fetch"));
    ana.pushManager.getSubscription.mockResolvedValue({ endpoint: "https://push.example/ana", getKey: () => null } as never);
    const { currentPush } = await import("../../../../web/src/pwa/push");
    await expect(currentPush("ana")).resolves.toEqual({ endpoint: "https://push.example/ana", p256dh: "", auth: "" });
  });
});
