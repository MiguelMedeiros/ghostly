import { copyInvite } from "../support/clipboard";
import { test, expect } from "../support/extension";
import { chat, say } from "../support/fixtures";

test("extension joins the real DHT QR and exchanges text with a web peer over the relay", { tag: ["@feature:invite.qr.image", "@feature:invite.dht", "@feature:chat.dht.send", "@feature:extension.interop"] }, async ({webPeer,extensionPeer})=>{
  const a=await webPeer("web-dht-qr"),b=await extensionPeer("extension-dht-qr");
  await a.page.getByTitle("New Chat").click();
  await a.page.getByRole("radio",{name:"Text only",exact:true}).click();
  await expect.poll(() => copyInvite(a.page)).toMatch(/^pair2d\//);
  const qr=await a.page.getByTestId("invite-qr").screenshot();
  await b.page.getByRole("button",{name: "Join chat", exact: true}).first().click();
  await b.page.getByLabel("Open image").setInputFiles({name:"invite.png",mimeType:"image/png",buffer:qr});
  for(const p of[a,b])await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
  await say(b,"Extension joined through QR");await expect(chat(a).getByText("Extension joined through QR",{exact:true})).toBeVisible();
  await expect(chat(b).getByText("Received by peer",{exact:true})).toBeVisible();
  await say(a,"Web reply over DHT");await expect(chat(b).getByText("Web reply over DHT",{exact:true})).toBeVisible();
  for(const p of[a,b])await expect(p.page.getByTestId("connection-options")).toHaveAccessibleName(/DHT only/);
});
