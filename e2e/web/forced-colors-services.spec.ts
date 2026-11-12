import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";
import { keepsAnEdge } from "../support/forcedColors";
import { HeadlessBot } from "../support/headless";

/**
 * A contact's shared web app in forced colors (Windows Contrast themes): its Open buttons, the pill in the chat's apps
 * strip and Open in the chat's Shared services dialog, are drawn by their fill alone, which forced colors replace with
 * the page's. They keep an edge there (they read as bold text beside "Apps you can open:" and the app's name), as the
 * Services page's Open does, and show none in normal colours.
 */
test("forced colors keep an edge on a contact's shared app's Open buttons", { tag: ["@feature:app.accessibility", "@feature:services.web-open"] }, async ({ peer, relay }, info) => {
  test.setTimeout(5 * 60_000);
  const url = await relay.listen();
  const app = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Demo</title><h1>Hello from the demo</h1>");
  });
  await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Demo bot");
    // The suite's build opens contacts' apps only in a page that asks for it (apps/web/src/host.ts, `servicesUnderTest`).
    const person = await peer("person", { serviceWorkers: "allow", beforeOpen: async (context) => { await context.addInitScript(() => {
      try { if (location.hostname === "localhost") localStorage.setItem("ghostly-test-services", "on"); } catch { /* opaque origin */ }
    }); } });
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    expect(await bot.run("service", "add", "Demo", `http://127.0.0.1:${(app.address() as AddressInfo).port}`)).toMatchObject({ serviceId: "demo" });
    await bot.run("service", "share", "demo", invite.chat as string);

    const strip = person.page.getByTestId("peer-services");
    await expect(strip.getByTestId("open-service")).toBeVisible({ timeout: 120_000 });
    await keepsAnEdge(person.page, strip.getByTestId("open-service"), "the apps strip's Demo");
    await strip.getByTestId("grant-services").click();
    await keepsAnEdge(person.page, person.page.getByTestId("chat-services").getByTestId("chat-service-open"), "the Shared services dialog's Open");
  } catch (error) {
    await bot.attachLogs(info);
    throw error;
  } finally {
    await bot.stop();
    app.close();
  }
});
