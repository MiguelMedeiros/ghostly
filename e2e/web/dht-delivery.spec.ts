import { copyInvite } from "../support/clipboard";
import { pasteInvite } from "../support/clipboard";
import { test, expect, chat, say, type Peer } from "../support/fixtures";
import { LocalRelay } from "../support/relay";

async function watchStreams(peer: Peer) {
  // Before creating/joining; retained on reload. This observes real browser construction.
  const instrument = () => {
    const Original = window.RTCPeerConnection;
    window.RTCPeerConnection = new Proxy(Original, { construct(target,args) { localStorage.setItem("qa-stream-dials", String(Number(localStorage.getItem("qa-stream-dials") ?? 0)+1)); return Reflect.construct(target,args); } });
  };
  await peer.page.addInitScript(instrument); await peer.page.evaluate(instrument);
}
async function createDht(peer:Peer) {
  await peer.page.getByTitle("New Chat").click();
  await peer.page.getByRole("radio",{name:"Text only",exact:true}).click();
  await expect.poll(() => copyInvite(peer.page)).toMatch(/^https:\/\/ghostly\.tools\/#ghostly1p/);
  return copyInvite(peer.page);
}
async function join(peer:Peer,invite:string) {
  await peer.page.getByRole("button",{name: "Join chat", exact: true}).first().click();
  await pasteInvite(peer.page, invite);
}
async function mode(peer:Peer,dht:boolean) {
  const menu=peer.page.getByTestId("connection-menu");
  if(await menu.getAttribute("open") === null) await peer.page.getByTestId("connection-options").click();
  const choice=peer.page.getByRole("switch",{name:"DHT-only delivery"});
  if(await choice.isChecked()!==dht) await choice.click();
  await expect.poll(()=>choice.isChecked()).toBe(dht);
  await peer.page.keyboard.press("Escape");
}
async function noStreams(peers:Peer[]) { for(const p of peers) expect(await p.page.evaluate(()=>Number(localStorage.getItem("qa-stream-dials")??0))).toBe(0); }
const received=(p:Peer)=>chat(p).getByText("Received by peer",{exact:true});

test("DHT-only starts from an invite without streams, preserves drafts and receipts across reload",{ tag: ["@feature:chat.dht.send", "@feature:invite.dht", "@feature:chat.waiting"] },async({peer,relay})=>{
  const a=await peer("dht-first"),b=await peer("dht-second");
  await watchStreams(a);await watchStreams(b);
  await join(b,await createDht(a));
  for(const p of [a,b]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
  const text="DHT íntegro 👻";
  await say(a,text);await expect(chat(b).getByText(text,{exact:true})).toBeVisible();await expect(received(a)).toHaveCount(1);
  expect([...relay.packets.values()].every(packet=>!packet.includes(Buffer.from(text)))).toBe(true);
  // Past the 256 bytes the DHT carries the counter turns amber, and the text waits for a live connection with a cancel (WISP 400).
  const large="👻".repeat(65); await b.page.getByPlaceholder("Message…").fill(large);
  await expect(b.page.getByTestId("dht-byte-count")).toHaveText("260 / 256 B");
  await b.page.getByRole("button",{name:"Send message",exact:true}).click();
  const waiting=chat(b).locator(".group").filter({hasText:large});
  await expect(waiting.getByText("Sends when live",{exact:true})).toBeVisible();await expect(b.page.getByPlaceholder("Message…")).toHaveValue("");
  await waiting.getByTestId("cancel-waiting").click();await expect(waiting).toHaveCount(0);
  await b.page.getByPlaceholder("Message…").fill("Reply over DHT");await b.page.getByRole("button",{name:"Send message",exact:true}).click();
  await expect(chat(a).getByText("Reply over DHT",{exact:true})).toBeVisible();await expect(received(b)).toHaveCount(1);
  await a.page.reload();await b.page.reload();
  // The inviter chose DHT only; the contact, whose ghostly1 code carries no mode, stays on the DHT it learnt from the envelopes.
  await expect(a.page.getByTestId("connection-options")).toHaveAccessibleName(/DHT only/);
  await expect(b.page.getByTestId("connection-options")).toHaveAccessibleName(/DHT/);
  for(const p of [a,b]) {await expect(chat(p).getByText(text,{exact:true})).toHaveCount(1);await expect(chat(p).getByText("Reply over DHT",{exact:true})).toHaveCount(1);}
  await noStreams([a]);
  // A file waits for a live connection instead of being refused.
  await expect(a.page.getByRole("button",{name:"Send a file",exact:true})).toBeEnabled();
});

test("DHT published while contact is away survives sender restart and is received once when contact returns",{ tag: ["@feature:chat.dht.offline"] },async({peer})=>{
  const a=await peer("dht-away-sender"),b=await peer("dht-away-reader");await watchStreams(a);await watchStreams(b);
  await join(b,await createDht(a));for(const p of[a,b])await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
  const returnTo=b.page.url();await b.page.goto("about:blank");
  await say(a,"Waiting in the DHT mailbox");await expect(chat(a).getByText("Sent · waiting for receipt",{exact:true})).toBeVisible();
  await expect(received(a)).toHaveCount(0);await a.page.reload();
  await expect(chat(a).getByText("Waiting in the DHT mailbox",{exact:true})).toHaveCount(1);
  await b.page.goto(returnTo);await expect(chat(b).getByText("Waiting in the DHT mailbox",{exact:true})).toHaveCount(1);await expect(received(a)).toHaveCount(1);
  await b.page.reload();await expect(chat(b).getByText("Waiting in the DHT mailbox",{exact:true})).toHaveCount(1);await noStreams([a]);
});

test("DHT and live delivery share history; offline text fallback is independent of strict stream fallback",{ tag: ["@feature:chat.dht.fallback"] },async({peer})=>{
  const a=await peer("dht-migrate-a"),b=await peer("dht-migrate-b");await join(b,await createDht(a));
  await expect(a.page.getByPlaceholder("Message…")).toBeEnabled();await say(a,"Before migration");await expect(chat(b).getByText("Before migration",{exact:true})).toBeVisible();await expect(received(a)).toHaveCount(1);
  await mode(b,false);await mode(a,false);
  for(const p of[a,b])await expect(p.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · WebRTC/);
  await say(b,"After migration");await expect(chat(a).getByText("After migration",{exact:true})).toBeVisible();
  await a.page.getByTestId("connection-options").click();
  const fallback=a.page.getByRole("switch",{name:"Fallback",exact:true});
  await fallback.click();await expect(fallback).not.toBeChecked();await a.page.keyboard.press("Escape");
  const returnTo=b.page.url();await b.page.goto("about:blank");
  await expect(a.page.getByTestId("connection-options")).toHaveAccessibleName(/DHT · offline text/);
  await say(a,"Offline delivery after stream");await expect(chat(a).getByText("Sent · waiting for receipt",{exact:true})).toBeVisible();
  await b.page.goto(returnTo);await expect(chat(b).getByText("Offline delivery after stream",{exact:true})).toHaveCount(1);
  await mode(a,true);await mode(b,true);await say(b,"Back to DHT");await expect(chat(a).getByText("Back to DHT",{exact:true})).toBeVisible();
  for(const p of[a,b]) for(const text of["Before migration","After migration","Offline delivery after stream","Back to DHT"])await expect(chat(p).getByText(text,{exact:true})).toHaveCount(1);
});

test("DHT network publication failures are visible and never claimed as receipt",{ tag: ["@feature:chat.dht.errors"] },async({peer})=>{
  const a=await peer("dht-publish-errors"),b=await peer("dht-publish-peer");await join(b,await createDht(a));
  await expect(a.page.getByPlaceholder("Message…")).toBeEnabled();
  await a.context.route(LocalRelay.pattern,route=>route.request().method()==="PUT"?route.fulfill({status:503,headers:{"access-control-allow-origin":"*"}}):route.fallback());
  await say(a,"This publication should fail");
  await expect(a.page.getByTestId("connection-options")).toHaveAccessibleName(/Connection issue/);
  await a.page.getByTestId("connection-options").click();await expect(a.page.getByRole("alert")).toContainText(/publish|relay|publishing/i);
  await expect(received(a)).toHaveCount(0);
});

test("a changed DHT participation key is rejected without replacing the saved contact",{ tag: ["@feature:chat.dht.key-change", "@feature:core.peer-keys"] },async({peer})=>{
  const a=await peer("dht-pinned"),b=await peer("dht-changed");await join(b,await createDht(a));
  await expect(a.page.getByPlaceholder("Message…")).toBeEnabled();
  await say(a,"Before the identity change");await expect(chat(b).getByText("Before the identity change",{exact:true})).toBeVisible();await expect(received(a)).toHaveCount(1);
  const readPin=()=>a.page.evaluate(()=>new Promise<string>((resolve,reject)=>{const request=indexedDB.open("ghostly");request.onsuccess=()=>{const db=request.result;const query=db.transaction("links").objectStore("links").getAll();query.onsuccess=()=>{resolve(query.result[0].pairedPeerKey);db.close();};query.onerror=()=>reject(query.error);};request.onerror=()=>reject(request.error);}));
  const before=await readPin();
  // Controlled corruption of this disposable peer's own persisted identity models key loss/replacement.
  await b.page.evaluate(()=>new Promise<void>((resolve,reject)=>{const request=indexedDB.open("ghostly");request.onsuccess=()=>{const db=request.result;const tx=db.transaction("links","readwrite"),store=tx.objectStore("links"),query=store.getAll();query.onsuccess=()=>{const link=query.result[0];link.participationSeed=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");store.put(link);};tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);};request.onerror=()=>reject(request.error);}));
  await b.page.reload();
  await expect(a.page.getByTestId("connection-options")).toHaveAccessibleName(/Connection issue/);
  await a.page.getByTestId("connection-options").click();await expect(a.page.getByRole("alert")).toContainText(/key|identity|pinned|contact/i);
  await expect(a.page.getByPlaceholder("Message…")).toBeDisabled();
  expect(await readPin()).toBe(before);
});
