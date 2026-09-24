import { copyInvite } from "../support/clipboard";
import { manualFallback } from "../support/clipboard";
import { pasteInvite } from "../support/clipboard";
import { test, expect } from "../support/fixtures";
import { pair } from "../support/paired";

const countChats = (page: import("@playwright/test").Page) => page.evaluate(() => Object.entries(localStorage).filter(([key, value]) => {try {return key.startsWith("ghostly_") && !!JSON.parse(value).mySeedB64;} catch {return false;}}).length);

test("New shows a real QR; Join decodes its image once and preserves a single conversation", { tag: ["@feature:invite.qr.show", "@feature:invite.qr.image"] }, async ({ peer }) => {
  const a = await peer("qr-owner"), b = await peer("qr-reader");
  await a.page.getByRole("button", {name: "New chat", exact: true}).click();
  await expect(a.page.getByPlaceholder("Paste invite…")).toHaveCount(0);
  await expect(a.page.getByText("Create a legacy chat")).toHaveCount(0);
  const qr = await a.page.getByTestId("invite-qr").screenshot();
  await b.page.getByRole("button", {name: "Join chat", exact: true}).first().click();
  await b.page.getByLabel("Open image").setInputFiles({name: "invite.png", mimeType: "image/png", buffer: qr});
  await expect(b.page.getByRole("dialog", {name: "Join a chat"})).toHaveCount(0);
  await expect.poll(() => countChats(b.page)).toBe(1);
  await expect(b.page.getByPlaceholder("Message…")).toBeEnabled();
  await b.page.getByPlaceholder("Message…").fill("QR image roundtrip");
  await b.page.getByPlaceholder("Message…").press("Enter");
  await expect(a.page.locator(".chat-wallpaper").getByText("QR image roundtrip", {exact: true})).toBeVisible();
});

test("Join camera decodes real QR frames, stops tracks, and rejects invalid input", { tag: ["@feature:invite.qr.camera", "@feature:invite.invalid"] }, async ({ peer }) => {
  const a = await peer("camera-owner"), b = await peer("camera-reader");
  await a.page.getByTitle("New Chat").click();
  const image = (await a.page.getByTestId("invite-qr").screenshot()).toString("base64");
  await b.page.evaluate(async image => {
    const picture = new Image(); picture.src = `data:image/png;base64,${image}`; await picture.decode();
    const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 640;
    const context = canvas.getContext("2d")!; context.fillStyle = "white"; context.fillRect(0,0,640,640); context.drawImage(picture, 100,100,440,440);
    const stream = canvas.captureStream(10);
    Object.assign(window, { qaCamera: stream, qaCameraRequests: 0 });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {configurable: true, value: async () => { Object.assign(window, {qaCameraRequests: (window as unknown as {qaCameraRequests:number}).qaCameraRequests + 1}); return stream; }});
  }, image);
  await b.page.getByRole("button", {name: "Join chat", exact: true}).first().click();
  expect(await b.page.evaluate(() => (window as unknown as {qaCameraRequests:number}).qaCameraRequests)).toBe(0);
  await manualFallback(b.page);
  await b.page.getByPlaceholder("Paste invite…").fill("javascript:alert('no')");
  await b.page.getByRole("dialog").getByRole("button",{name: "Join chat", exact: true}).click();
  await expect(b.page.getByRole("alert")).toContainText("Invalid invite");
  await b.page.getByRole("button", {name: "Scan QR"}).click();
  await expect(b.page.getByRole("dialog", {name:"Join a chat"})).toHaveCount(0);
  await expect.poll(() => countChats(b.page)).toBe(1);
  expect(await b.page.evaluate(() => (window as unknown as {qaCamera:MediaStream}).qaCamera.getTracks().every(t=>t.readyState === "ended"))).toBe(true);
});

test("Join camera permission and cancellation keep paste available and release a late camera", { tag: ["@feature:invite.qr.camera"] }, async ({ peer }) => {
  const {page} = await peer("camera-errors");
  await page.evaluate(() => Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable:true, value: async () => {throw new DOMException("denied", "NotAllowedError");} }));
  await page.getByRole("button", {name: "Join chat", exact: true}).first().click();
  await page.getByRole("button", {name:"Scan QR"}).click();
  await expect(page.getByRole("alert")).toContainText("Camera unavailable");
  await expect(page.getByPlaceholder("Paste invite…")).toBeEnabled();
  await page.evaluate(() => {
    const canvas = document.createElement("canvas"), stream=canvas.captureStream();
    Object.assign(window,{qaCamera:stream});
    Object.defineProperty(navigator.mediaDevices,"getUserMedia",{configurable:true,value:()=>new Promise(resolve=>{Object.assign(window,{qaResolveCamera:()=>resolve(stream)});})});
  });
  await page.getByRole("button", {name:"Scan QR"}).click();
  await page.getByRole("button", {name:"Cancel",exact:true}).first().click();
  await page.evaluate(()=>(window as unknown as {qaResolveCamera():void}).qaResolveCamera());
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {qaCamera:MediaStream}).qaCamera.getTracks().every(t=>t.readyState==="ended"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await countChats(page)).toBe(0);
});

test("header connection popover, four desktop destinations and resizing preserve a multiline draft", { tag: ["@feature:chat.paired.status", "@feature:chat.paired.draft", "@feature:app.sidebar-resize"] }, async ({peer}, testInfo) => {
  const a=await peer("layout-owner"), b=await peer("layout-guest");
  await pair(a,b);
  const box=a.page.getByPlaceholder("Message…");
  await box.fill("First line\nSecond line");
  const trigger=a.page.getByTestId("connection-options");
  await trigger.click();
  await expect(a.page.getByRole("dialog",{name:"Connection options"})).toBeVisible();
  await expect(a.page.getByRole("radio",{name:"WebRTC",exact:true})).toBeChecked();
  await expect(a.page.getByRole("switch",{name:"Fallback",exact:true})).toBeVisible();
  await expect(a.page.getByTestId("pair-verify")).toBeVisible();
  await a.page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await expect(a.page.getByRole("dialog",{name:"Connection options"})).toBeHidden();
  await expect(box).toHaveValue("First line\nSecond line");
  for(const width of [280,435,600]) {
    const handle=await a.page.getByTestId("sidebar-resize").boundingBox();
    await a.page.mouse.move(handle!.x+2,handle!.y+100); await a.page.mouse.down(); await a.page.mouse.move(width,handle!.y+100); await a.page.mouse.up();
    // New (with its arrow for a group) and Join share the header evenly.
    const newBounds = (await a.page.getByTestId("sidebar-new").boundingBox())!, joinBounds = (await a.page.getByTestId("sidebar-chat-actions").getByRole("button", { name: "Join chat" }).boundingBox())!;
    expect(Math.abs(newBounds.width - joinBounds.width)).toBeLessThanOrEqual(1);
    expect(newBounds.height).toBe(joinBounds.height);
    expect(joinBounds.x + joinBounds.width).toBeLessThanOrEqual(width);
    const footer=a.page.getByTestId("account-bar");
    expect((await a.page.getByTestId("sidebar").boundingBox())!.width).toBe(width);
    expect((await footer.boundingBox())!.width).toBeGreaterThanOrEqual(width-1);
    for(const id of ["account-profile","wallet-chip","account-services","account-settings"]) {
      const action=a.page.getByTestId(id); await expect(action).toBeVisible(); expect((await action.boundingBox())!.width).toBeGreaterThan(44);
    }
    const walletLabel = a.page.locator(".account-wallet-label");
    await expect(walletLabel).toHaveText("0 sats");
    const rows = await Promise.all([".account-label", ".account-wallet-label"].map(selector => footer.locator(selector).evaluateAll(elements => elements.map(el => el.getBoundingClientRect().y))));
    const baselines = rows.flat(); expect(Math.max(...baselines) - Math.min(...baselines)).toBeLessThanOrEqual(1);
    await a.page.screenshot({path:testInfo.outputPath(`sidebar-${width}.png`)});
  }
  await a.page.getByTestId("account-profile").click(); await expect(a.page.getByTestId("account-nickname")).toBeVisible();
  await a.page.getByTestId("wallet-chip").click(); await expect(a.page.getByTestId("platform-notice")).toBeVisible();
  await a.page.getByTestId("account-services").click(); await expect(a.page.getByText("needs the Ghostly browser extension or desktop app").first()).toBeVisible();
  await a.page.getByTestId("account-settings").click(); await expect(a.page).toHaveURL(/settings/);
});

test("mobile keeps its footer and compact header, with multiline text and QR inside the viewport", { tag: ["@feature:app.mobile-layout", "@feature:chat.paired.draft"] }, async ({peer},testInfo)=>{
  const a=await peer("mobile-owner",{mobile:true}),b=await peer("mobile-guest",{mobile:true});
  await a.page.getByTitle("New Chat").click();
  const card=await a.page.getByTestId("invite-card").boundingBox(); expect(card!.x).toBeGreaterThanOrEqual(0);expect(card!.x+card!.width).toBeLessThanOrEqual(390);
  const invite=await copyInvite(a.page);
  await b.page.getByRole("button",{name: "Join chat", exact: true}).first().click();await pasteInvite(b.page, invite);
  await expect(a.page.getByPlaceholder("Message…")).toBeEnabled();
  await expect(a.page.getByTestId("account-bar")).toHaveCount(0);
  await a.page.getByPlaceholder("Message…").fill("Line one\nLine two");
  // Only the icon in the header, with the call buttons, and nothing past the edge.
  const icon=a.page.getByTestId("connection-options"); await expect(icon).toHaveText("");
  const iconBox=(await icon.boundingBox())!, call=(await a.page.getByTitle("Video calls are not supported in this chat").boundingBox())!;
  expect(Math.abs(iconBox.width-call.width)).toBeLessThanOrEqual(1); expect(iconBox.x+iconBox.width).toBeLessThanOrEqual(390);
  expect(await icon.evaluate(el=>{const h=el.closest(".header-safe")!;return h.scrollWidth<=h.clientWidth;})).toBe(true);
  await a.page.getByTestId("connection-options").click();await expect(a.page.getByRole("dialog",{name:"Connection options"})).toBeVisible();
  const menu=await a.page.getByRole("dialog",{name:"Connection options"}).boundingBox(); expect(menu!.x).toBeGreaterThanOrEqual(0); expect(menu!.x+menu!.width).toBeLessThanOrEqual(390);
  await a.page.screenshot({path:testInfo.outputPath("mobile-menu.png")});
  await a.page.keyboard.press("Escape"); await expect(a.page.getByPlaceholder("Message…")).toHaveValue("Line one\nLine two");
});

test("new DHT invite QR preserves delivery mode from creation through Join", { tag: ["@feature:invite.dht", "@feature:invite.qr.image"] }, async ({peer})=>{
  const a=await peer("dht-qr-owner"),b=await peer("dht-qr-reader");
  await a.page.getByTitle("New Chat").click();
  await a.page.getByRole("radio",{name:"Text only",exact:true}).click();
  await expect.poll(() => copyInvite(a.page)).toMatch(/^pair2d\//);
  await expect(a.page.getByTestId("connection-options")).toHaveAccessibleName(/DHT only/);
  const qr=await a.page.getByTestId("invite-qr").screenshot();
  await b.page.getByRole("button",{name: "Join chat", exact: true}).first().click();
  await b.page.getByLabel("Open image").setInputFiles({name:"dht-invite.png",mimeType:"image/png",buffer:qr});
  await expect(b.page.getByTestId("connection-options")).toHaveAccessibleName(/DHT only/);
  await b.page.getByTestId("connection-options").click();
  await expect(b.page.getByRole("switch",{name:"DHT-only delivery"})).toBeChecked();
  await expect(b.page.getByRole("radio",{name:"WebRTC",exact:true})).toBeDisabled();
  await expect(b.page.getByTestId("dht-delivery-details")).toContainText("Published is not received");
  await b.page.keyboard.press("Escape");
});

test("home actions have equal sizes and enabled controls signal clicks", { tag: ["@feature:app.home"] }, async ({peer}, testInfo) => {
  for (const mobile of [false, true]) {
    const p = await peer(`action-affordances-${mobile}`, {mobile});
    const actions = p.page.getByTestId("home-chat-actions").getByRole("button");
    const create = mobile ? p.page.getByRole("button", {name:"New chat", exact:true}) : actions.nth(0);
    const join = mobile ? p.page.getByRole("button", {name: "Join chat", exact: true}).first() : actions.nth(1);
    // Home fades in: let it settle, then measure both, so the animation cannot land between them.
    await p.page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity));
    // On a phone these are the list's header actions, where New shares its cell with the arrow that offers a group.
    const first = (await (mobile ? p.page.getByTestId("sidebar-new") : create).boundingBox())!, second = (await join.boundingBox())!;
    expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1);
    expect(first.height).toBe(second.height); expect(Math.abs(first.y - second.y)).toBeLessThan(0.5);
    await expect(create).toHaveCSS("cursor", "pointer"); await expect(join).toHaveCSS("cursor", "pointer");
    expect(second.x + second.width).toBeLessThanOrEqual(p.page.viewportSize()!.width);
    await p.page.screenshot({path:testInfo.outputPath(`home-${mobile ? "mobile" : "desktop"}.png`)});
    for (const button of [create, join]) {
      const padding = await button.evaluate(el => {const s=getComputedStyle(el);return [s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft];});
      expect(padding[0]).toBe(padding[2]); expect(padding[1]).toBe(padding[3]);
    }
    await join.click();
    const close = p.page.getByRole("button", {name:"Close join", exact:true});
    await expect(close).toHaveCSS("cursor", "pointer"); await close.click();
    await create.click();
    const menu = p.page.getByTestId("connection-options");
    await expect(menu).toHaveCSS("cursor", "pointer"); await menu.click();
    await expect(p.page.getByRole("switch", {name:"DHT-only delivery"})).toHaveCSS("cursor", "pointer");
    await expect(p.page.getByRole("radio", {name:"WebRTC", exact:true})).toHaveCSS("cursor", "pointer");
    await expect(p.page.getByRole("radio", {name:"Iroh", exact:true})).toHaveCSS("cursor", "not-allowed");
    await expect(p.page.getByRole("button", {name:"Send message", exact:true})).toBeDisabled();
    await expect(p.page.getByRole("button", {name:"Send message", exact:true})).toHaveCSS("cursor", "not-allowed");
  }
});

for (const unavailable of ["none", "read", "publish", "network", "publication-network"] as const) {
  test(`new chat distinguishes absent contact from discovery ${unavailable} failure`, { tag: ["@feature:invite.discovery-errors"] }, async ({peer}) => {
    const {page, context} = await peer(`new-discovery-${unavailable}`);
    let reads = 0;
    await context.route(/^https:\/\/pkarr\.pubky\.(org|app)\//, route => {
      const read = route.request().method() === "GET";
      if (read) reads++;
      if (unavailable === "network" || (unavailable === "publication-network" && !read)) return route.abort("failed");
      const limited = unavailable === (read ? "read" : "publish");
      return route.fulfill({status: limited ? 429 : read ? 404 : 204,
        headers: {"access-control-allow-origin":"*", "retry-after":"1"}});
    });
    await page.getByRole("button", {name:"New chat", exact:true}).click();
    await expect.poll(() => copyInvite(page)).toMatch(/^pair1\//);
    const menu = page.getByTestId("connection-options");
    await expect.poll(() => reads).toBeGreaterThan(0);
    await expect(menu).toHaveAccessibleName(unavailable === "none" ? /No contact yet/ : unavailable === "publication-network" ? /Publication unavailable/ : /Discovery unavailable|Publication unavailable/);
    await menu.click();
    if (unavailable === "none") await expect(page.getByRole("alert")).toHaveCount(0);
    else {
      await expect(page.getByRole("alert")).toContainText(unavailable === "network" ? /Could not (read|publish) discovery/ : `Could not ${unavailable === "publication-network" ? "publish" : unavailable} discovery`);
      await expect(page.getByTestId("discovery-help")).toContainText("retry automatically");
      if (unavailable === "publication-network") {
        await expect(page.getByRole("alert")).not.toContainText("Could not read discovery");
        await expect(page.getByTestId("discovery-help")).toContainText("No contact yet");
      }
      await expect(page.getByRole("link", {name:"review relay settings"})).toHaveAttribute("href", "#/settings");
    }
    await expect(page.getByRole("switch", {name:"DHT-only delivery"})).toBeEnabled();
    await expect(page.getByRole("radio", {name:"WebRTC", exact:true})).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("invite-card").getByRole("button",{name:/Copy invite|Copied!/})).toBeVisible();
  });
}
