import { copyInvite } from "../support/clipboard";
import {test,expect} from "../support/fixtures";
import {setClipboard} from "../support/clipboard";

test("clipboard joins once from the explicit action",async({peer})=>{
 const a=await peer("clipboard-owner"),b=await peer("clipboard-guest");
 await a.page.getByTitle("New Chat").click();
 const invite=await copyInvite(a.page);
 await setClipboard(b.page,invite);
 await b.page.getByRole("button",{name: "Join chat", exact: true}).first().click();
 await expect(b.page.getByPlaceholder("Paste invite…")).toHaveCount(0);
 await b.page.getByRole("button",{name:"Paste from clipboard",exact:true}).click();
 await expect(b.page.getByRole("dialog")).toHaveCount(0);
 await expect(b.page.getByPlaceholder("Message…")).toBeVisible();
 const count=await b.page.evaluate(()=>Object.values(localStorage).filter(v=>{try{return !!JSON.parse(v).mySeedB64;}catch{return false;}}).length);
 expect(count).toBe(1);
});

for(const value of [null,"","not-an-invite"]) test(`clipboard fallback is editable: ${value === null ? "denied" : value === "" ? "empty" : "invalid"}`,async({peer})=>{
 const {page}=await peer("clipboard-fallback");
 await setClipboard(page,value);
 await page.getByRole("button",{name: "Join chat", exact: true}).first().click();
 const trigger=page.getByRole("button",{name:"Paste from clipboard",exact:true});
 await expect(trigger).toBeFocused();
 await trigger.click();
 await expect(page.getByRole("alert")).toBeVisible();
 await expect(page.getByPlaceholder("Paste invite…")).toBeFocused();
 await page.getByPlaceholder("Paste invite…").fill("still invalid");
 await page.getByRole("dialog").getByRole("button",{name:"Join chat",exact:true}).click();
 await expect(page.getByRole("alert")).toHaveText("Invalid invite. Ask for a new one.");
 if(value === null) {
   const owner=await peer("manual-owner");
   await owner.page.getByTitle("New Chat").click();
   const invite=await copyInvite(owner.page);
   await page.getByPlaceholder("Paste invite…").fill(invite);
   await page.getByRole("dialog").getByRole("button",{name:"Join chat",exact:true}).click();
   await expect(page.getByPlaceholder("Message…")).toBeVisible();
 } else {
   await page.keyboard.press("Escape");
 }
 await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("closing Join cancels a pending clipboard read and duplicate requests",async({peer})=>{
 const a=await peer("late-owner"),b=await peer("late-guest");
 await a.page.getByTitle("New Chat").click();
 const invite=await copyInvite(a.page);
 await b.page.evaluate(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{readText:()=>new Promise<string>(resolve=>{Object.assign(window,{resolveClipboard:resolve});})}}));
 await b.page.getByRole("button",{name: "Join chat", exact: true}).first().click();
 await b.page.getByRole("button",{name:"Paste from clipboard",exact:true}).click();
 await expect(b.page.getByRole("button",{name:"Paste from clipboard",exact:true})).toBeDisabled();
 await b.page.mouse.click(2,2);
 await b.page.evaluate(value=>(window as unknown as {resolveClipboard(value:string):void}).resolveClipboard(value),invite);
 await expect(b.page.getByRole("dialog")).toHaveCount(0);
 await expect(b.page.getByPlaceholder("Message…")).toHaveCount(0);
});

test("closing Join discards an image decoded late",async({peer})=>{
 const a=await peer("image-owner"),b=await peer("image-cancel",{mobile:true});
 await a.page.getByTitle("New Chat").click();
 const qr=await a.page.getByTestId("invite-qr").screenshot();
 await b.page.evaluate(()=>{
  const decode=window.createImageBitmap.bind(window);
  window.createImageBitmap=((...args:Parameters<typeof createImageBitmap>)=>decode(...args).then(bitmap=>new Promise<ImageBitmap>(resolve=>{Object.assign(window,{resolveImage:()=>resolve(bitmap)});}))) as typeof createImageBitmap;
 });
 await b.page.getByRole("button",{name: "Join chat", exact: true}).first().click();
 await b.page.getByLabel("Open image").setInputFiles({name:"invite.png",mimeType:"image/png",buffer:qr});
 await expect.poll(()=>b.page.evaluate(()=>typeof (window as unknown as {resolveImage:unknown}).resolveImage)).toBe("function");
 await b.page.keyboard.press("Escape");
 await b.page.evaluate(()=>(window as unknown as {resolveImage():void}).resolveImage());
 await expect(b.page.getByRole("dialog")).toHaveCount(0);
 await expect(b.page.getByPlaceholder("Message…")).toHaveCount(0);
});
