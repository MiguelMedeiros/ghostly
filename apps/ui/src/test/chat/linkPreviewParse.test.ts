import { describe, expect, it } from "vitest";
import { createChatInvite, inviteLink } from "@ghostly/core";
import { decodeEntities, isLocalHost, oEmbedEndpoint, parseOEmbed, parseOpenGraph, previewableLink, videoSite } from "../../lib/parse/linkPreview";
import { decodePage } from "../../lib/linkPreviewFetch";
import { findLocation, formatCoordinates, locationIn, mapTiles, mapsUrl } from "../../lib/parse/location";

// covers: chat.link-preview.compose, chat.location.card

describe("parseOpenGraph", () => {
  const page = `<!doctype html><html><head>
    <meta charset="utf-8"><title>Plain title</title>
    <!-- <meta property="og:title" content="In a comment"> -->
    <script>var x = '<meta property="og:title" content="In a script">';</script>
    <meta property="og:title" content="Caf&eacute; &amp; &quot;Bar&quot; &#8230; &#x1F47B;">
    <meta content='A place to meet' property='og:description'>
    <meta name="description" content="Plain description">
    <meta property="og:site_name" content="Example News">
    <meta property="og:image" content="/img/card.jpg">
    <meta name=twitter:image content=https://cdn.example/t.jpg>
  </head><body><meta property="og:title" content="In the body"></body></html>`;

  it("reads Open Graph first, from the head only, never from comments or scripts", () => {
    expect(parseOpenGraph(page, "https://news.example/a/b")).toEqual({
      title: "Caf&eacute; & \"Bar\" … 👻",
      description: "A place to meet",
      site: "Example News",
      image: "https://news.example/img/card.jpg",
    });
  });

  it("falls back to Twitter card tags, then the plain title and description", () => {
    const meta = parseOpenGraph(`<head><title>  Just a
      title </title><meta name="description" content="Says what it is"><meta name="twitter:image:src" content="https://cdn.example/x.png"></head>`, "https://x.example/");
    expect(meta).toEqual({ title: "Just a title", description: "Says what it is", site: undefined, image: "https://cdn.example/x.png" });
  });

  it("takes only http(s) pictures", () => {
    for (const image of ["javascript:alert(1)", "data:image/png;base64,AAAA", "file:///etc/passwd"])
      expect(parseOpenGraph(`<meta property="og:image" content="${image}">`, "https://x.example/").image).toBeUndefined();
  });

  it("decodes a page in the charset it declares", () => {
    const latin1 = Uint8Array.from([...'<meta charset="iso-8859-1"><title>'].map(c => c.charCodeAt(0)).concat([0x43, 0x61, 0x66, 0xe9], [...'</title>'].map(c => c.charCodeAt(0))));
    expect(parseOpenGraph(decodePage(latin1, "text/html"), "https://x.example/").title).toBe("Café");
    expect(decodeEntities("&lt;b&gt; &#0; &unknown;")).toBe("<b> &#0; &unknown;");
  });
});

describe("oEmbed and video sites", () => {
  it("asks only YouTube's and Vimeo's own endpoints", () => {
    expect(oEmbedEndpoint("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ");
    expect(oEmbedEndpoint("https://youtu.be/dQw4w9WgXcQ")).toMatch(/^https:\/\/www\.youtube\.com\/oembed\?/);
    expect(oEmbedEndpoint("https://vimeo.com/76979871")).toMatch(/^https:\/\/vimeo\.com\/api\/oembed\.json\?url=/);
    expect(oEmbedEndpoint("https://news.example/watch?v=1")).toBeNull();
    expect(videoSite("https://m.youtube.com/shorts/abc")).toBe("youtube");
    expect(videoSite("https://www.youtube.com/")).toBeNull();
  });

  it("reads title, author and thumbnail from an answer", () => {
    expect(parseOEmbed({ title: "A video", author_name: "Someone", provider_name: "YouTube", thumbnail_url: "https://i.ytimg.com/vi/x/hqdefault.jpg" }, "https://www.youtube.com/oembed"))
      .toEqual({ title: "A video", description: "by Someone", site: "YouTube", image: "https://i.ytimg.com/vi/x/hqdefault.jpg" });
    expect(parseOEmbed("nope", "https://x.example/")).toEqual({});
  });
});

describe("which link gets a preview", () => {
  it("never a host on this machine or the local network", () => {
    for (const host of ["localhost", "app.localhost", "printer.local", "router", "10.0.0.1", "127.0.0.1", "192.168.1.20", "172.20.1.1", "169.254.169.254", "100.81.12.32", "[::1]", "[fd00::1]", "[::ffff:10.0.0.1]"])
      expect(isLocalHost(host), host).toBe(true);
    for (const host of ["example.com", "news.example.org", "93.184.215.14", "[2606:4700::1111]"])
      expect(isLocalHost(host), host).toBe(false);
  });

  it("the first web link that is not a picture, a place, or still being typed", () => {
    expect(previewableLink("see https://news.example/a and https://other.example/b")).toBe("https://news.example/a");
    expect(previewableLink("https://i.example/cat.gif then https://news.example/a")).toBe("https://news.example/a");
    expect(previewableLink("https://www.google.com/maps/@38.7,-9.1,15z")).toBeNull();
    expect(previewableLink("typing https://exam")).toBeNull();
    expect(previewableLink("http://192.168.0.1/admin")).toBeNull();
    expect(previewableLink("no link")).toBeNull();
    // An invite link is a card of its own, made from the code: its page is never asked.
    expect(previewableLink(`join ${inviteLink(createChatInvite().inviteCode)}`)).toBeNull();
  });
});

describe("places in a message", () => {
  it.each([
    ["geo:38.6916,-9.2160", { lat: 38.6916, lon: -9.216 }],
    ["geo:38.6916,-9.2160;u=35?z=17", { lat: 38.6916, lon: -9.216, zoom: 17 }],
    ["geo:0,0?q=38.6916,-9.2160(Padr%C3%A3o%20dos%20Descobrimentos)", { lat: 38.6916, lon: -9.216, name: "Padrão dos Descobrimentos" }],
    ["https://www.google.com/maps/place/Torre+de+Bel%C3%A9m/@38.6916,-9.2160,17z/data=!3m1", { lat: 38.6916, lon: -9.216, name: "Torre de Belém", zoom: 17 }],
    ["https://maps.google.com/?q=38.6916,-9.2160", { lat: 38.6916, lon: -9.216 }],
    ["https://www.google.com/maps/search/?api=1&query=38.6916%2C-9.2160", { lat: 38.6916, lon: -9.216 }],
    ["https://maps.apple.com/?ll=38.6916,-9.2160&q=Bel%C3%A9m", { lat: 38.6916, lon: -9.216, name: "Belém" }],
    ["https://maps.apple.com/place?coordinate=38.6916,-9.2160&name=Tower", { lat: 38.6916, lon: -9.216, name: "Tower" }],
    ["https://www.openstreetmap.org/?mlat=38.6916&mlon=-9.2160#map=16/38.6916/-9.2160", { lat: 38.6916, lon: -9.216, zoom: 16 }],
    ["https://www.openstreetmap.org/#map=12/38.6916/-9.2160", { lat: 38.6916, lon: -9.216, zoom: 12 }],
  ])("reads %s", (link, expected) => {
    expect(findLocation(link)).toEqual({ ...expected, source: link });
  });

  it("leaves what holds no coordinates, or impossible ones", () => {
    for (const link of ["geo:0,0?q=Lisbon", "geo:91,0", "geo:10,181", "https://maps.app.goo.gl/abc123", "https://www.google.com/maps/search/Lisbon", "https://news.example/?q=38.7,-9.1", "https://maps.apple.com/?q=Lisbon"])
      expect(findLocation(link), link).toBeNull();
  });

  it("finds the first place of a text, as a link ends", () => {
    expect(locationIn("meet here: geo:38.6916,-9.2160. ok?")).toMatchObject({ lat: 38.6916, lon: -9.216, source: "geo:38.6916,-9.2160" });
    expect(locationIn("(https://www.openstreetmap.org/#map=12/38.6916/-9.2160)")).toMatchObject({ lat: 38.6916 });
    expect(locationIn("just words")).toBeNull();
  });

  it("opens in the maps app each system has, and draws the place near the middle of its tiles", () => {
    const place = { lat: 38.6916, lon: -9.216, name: "Belém", source: "geo:38.6916,-9.2160" };
    expect(formatCoordinates(place)).toBe("38.69160, -9.21600");
    expect(mapsUrl(place, "apple")).toBe("https://maps.apple.com/?ll=38.6916,-9.216&q=Bel%C3%A9m");
    expect(mapsUrl(place, "android")).toBe("geo:38.6916,-9.216?q=38.6916,-9.216(Bel%C3%A9m)");
    expect(mapsUrl(place, "other")).toBe("https://www.openstreetmap.org/?mlat=38.691600&mlon=-9.216000#map=16/38.691600/-9.216000");
    const { tiles, point } = mapTiles(place);
    expect(tiles.map(t => t.src)).toEqual(expect.arrayContaining([expect.stringMatching(/^https:\/\/tile\.openstreetmap\.org\/15\/\d+\/\d+\.png$/)]));
    expect(tiles).toHaveLength(4);
    for (const axis of [point.x, point.y]) { expect(axis).toBeGreaterThanOrEqual(128); expect(axis).toBeLessThanOrEqual(384); }
  });
});
