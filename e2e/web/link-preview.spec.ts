import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chat, expect, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Link previews (WISP 401 § Link previews), between two people on the web: the sender's app reads a page's Open
 * Graph tags and picture from a real HTTP server, shows the preview in the composer and sends it with the message;
 * the receiver draws it from the message and never contacts that server. Location cards need no server at all:
 * their map loads from OpenStreetMap only on tap (stubbed here).
 *
 * The server listens on 127.0.0.1, which Ghostly never previews (a page must not reach the local network), so the
 * browser is told that `og.ghostly.test` is 127.0.0.1: to the app it is a public name, as a real site's would be.
 */

const HOST = "og.ghostly.test";
const PICTURE = readFileSync(fileURLToPath(new URL("../../src-tauri/icons/Square142x142Logo.png", import.meta.url)));

test.use({
  launchOptions: {
    args: [
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    ],
  },
});

interface Site { server: Server; origin: string; requests: string[] }

/** A site with a page that describes itself, and its picture. It allows reading (CORS), as some sites do. */
async function site(): Promise<Site> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("access-control-allow-origin", "*");
    if (request.url?.startsWith("/card.png")) {
      response.setHeader("content-type", "image/png");
      response.end(PICTURE);
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><title>Plain</title>
      <meta property="og:title" content="Ghosts &amp; peers">
      <meta property="og:description" content="Chat with no server in the middle.">
      <meta property="og:site_name" content="Ghostly Test News">
      <meta property="og:image" content="/card.png">
      </head><body>…</body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://${HOST}:${(server.address() as AddressInfo).port}`, requests };
}

/** Every request `peer`'s page makes to `host`. */
function watch(peer: Peer, host: string): string[] {
  const seen: string[] = [];
  peer.context.on("request", request => { if (new URL(request.url()).hostname === host) seen.push(request.url()); });
  return seen;
}

const bubble = (peer: Peer, text: string) => chat(peer).locator("[data-message-row]").filter({ hasText: text }).last();

test("a link preview is made by the sender and drawn by the receiver without contacting the site", { tag: ["@feature:chat.link-preview.compose", "@feature:chat.link-preview.render", "@feature:chat.link-preview.wire"] }, async ({ peer }) => {
  const news = await site();
  try {
    const [alice, bob] = await Promise.all([peer("preview-alice"), peer("preview-bob")]);
    const bobAsked = watch(bob, HOST);
    await pair(alice, bob);

    const text = `read this ${news.origin}/story?id=7&utm_source=chat`;
    await alice.page.getByPlaceholder("Message…").fill(text);
    const draft = alice.page.getByTestId("composer-link-preview");
    await expect(draft).toHaveAttribute("data-status", "ready");
    await expect(draft).toContainText("Ghosts & peers");
    // The page (without its tracking parameter) and its picture, each read once, by the sender.
    expect(news.requests).toEqual(["/story?id=7", "/card.png"]);
    await alice.page.getByPlaceholder("Message…").press("Enter");
    await expect(draft).toHaveCount(0);

    // Both sides show the card; the thumbnail is the sender's redrawn JPEG, carried in the message.
    for (const side of [alice, bob]) {
      const card = bubble(side, "read this").getByTestId("link-preview-card");
      await expect(card).toBeVisible();
      await expect(card.getByTestId("link-preview-title")).toHaveText("Ghosts & peers");
      await expect(card.getByTestId("link-preview-site")).toHaveText("Ghostly Test News");
      await expect(card).toHaveAttribute("href", `${news.origin}/story?id=7`);
      await expect(card.getByTestId("link-preview-image")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    }
    // The receiver asked the site nothing, and neither did anyone after the sender's two requests.
    expect(bobAsked).toEqual([]);
    expect(news.requests).toEqual(["/story?id=7", "/card.png"]);

    // Removed from the composer, the link goes as plain text: no card on either side, and nothing more is asked.
    await alice.page.getByPlaceholder("Message…").fill(`again ${news.origin}/other`);
    await expect(alice.page.getByTestId("composer-link-preview")).toHaveAttribute("data-status", "ready");
    await alice.page.getByTestId("link-preview-remove").click();
    await say(alice, `again ${news.origin}/other`);
    await expect(bubble(bob, "again")).toBeVisible();
    await expect(bubble(bob, "again").getByTestId("link-preview-card")).toHaveCount(0);
    await expect(bubble(alice, "again").getByTestId("link-preview-card")).toHaveCount(0);
    expect(bobAsked).toEqual([]);
  } finally {
    news.server.close();
  }
});

test("a place in a message shows a location card, and its map loads from OpenStreetMap only on tap", { tag: ["@feature:chat.location.card"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("place-alice"), peer("place-bob")]);
  const tiles: string[] = [];
  await bob.context.route("https://tile.openstreetmap.org/**", route => {
    tiles.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "image/png", body: PICTURE });
  });
  await pair(alice, bob);

  await say(alice, "meet me at geo:0,0?q=38.6916,-9.2160(Torre%20de%20Bel%C3%A9m)");
  const card = bubble(bob, "meet me at").getByTestId("location-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("location-name")).toHaveText("Torre de Belém");
  await expect(card.getByTestId("location-coordinates")).toHaveText("38.69160, -9.21600");
  await expect(card).toContainText("OpenStreetMap, which then sees your IP address");
  expect(tiles).toEqual([]);

  await card.getByTestId("location-show-map").click();
  await expect(card.getByTestId("location-map")).toBeVisible();
  await expect.poll(() => tiles.length).toBe(4);
  for (const tile of tiles) expect(tile).toMatch(/^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/);
  await expect(card.getByTestId("location-open")).toHaveAttribute("href", /^https:\/\/(maps\.apple\.com|www\.openstreetmap\.org)\//);
});
