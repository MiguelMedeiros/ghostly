import {test,expect} from "../support/fixtures";
import {copyInvite} from "../support/clipboard";

for(const mobile of [false,true]) test(`invite actions share the one invite in full (mobile=${mobile})`,{tag:["@feature:invite.delivery-mode", "@feature:invite.share", "@feature:invite.create","@feature:app.popovers"]},async({peer})=>{
 const {page}=await peer("invite-actions",{mobile});
 await page.evaluate(()=>Object.defineProperty(navigator,"share",{configurable:true,value:async(data:ShareData)=>{Object.assign(window,{qaShare:data});}}));
 await page.getByTitle("New Chat").click();
 const card=page.getByTestId("invite-card");
 await expect(card.getByRole("textbox")).toHaveCount(0);
 // One chat, one invite (WISP 400): no delivery choice on the card.
 await expect(card.getByRole("radio")).toHaveCount(0);
 const copied=await copyInvite(page);
 const expected=await page.evaluate(()=>localStorage.getItem("ghostly_invite_"+location.hash.split("/").at(-1)));
 // One ghostly1 code, shared as its link in full.
 expect(copied).toBe(`https://ghostly.tools/#${expected}`);
 expect(expected).toMatch(/^ghostly1p[02-9ac-hj-np-z]{211}$/);
 await card.getByRole("button",{name:"Share",exact:true}).click();
 expect(await page.evaluate(()=>(window as unknown as {qaShare:ShareData}).qaShare.text)).toBe(copied);
});

test("copy failures never report success; legacy copy fallback preserves the invite",{tag:["@feature:invite.copy"]},async({peer})=>{
 const {page}=await peer("invite-errors");
 await page.getByTitle("New Chat").click();
 const expected=await copyInvite(page);
 await page.evaluate(()=>{
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async()=>{throw new DOMException("denied","NotAllowedError");}}});
  document.execCommand=()=>false;
 });
 const card=page.getByTestId("invite-card");
 await card.getByRole("button",{name:/Copy invite|Copied!/}).click();
 await expect(card.getByRole("alert")).toContainText("Could not copy");
 await expect(card.getByRole("button",{name:"Copied!",exact:true})).toHaveCount(0);
 await page.evaluate(()=>{document.execCommand=()=>{Object.assign(window,{qaFallback:(document.activeElement as HTMLTextAreaElement).value});return true;};});
 await card.getByRole("button",{name:"Copy invite",exact:true}).click();
 await expect(card.getByRole("button",{name:"Copied!",exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as unknown as {qaFallback:string}).qaFallback)).toBe(expected);
});
