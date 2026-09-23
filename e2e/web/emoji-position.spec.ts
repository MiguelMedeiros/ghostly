import {test,expect} from "../support/fixtures";
import type {Page} from "@playwright/test";

async function fits(page:Page){
 const box=page.getByTestId("emoji-popover");await expect(box).toBeVisible();
 await expect.poll(async()=>{
  const rect=await box.boundingBox();const viewport=page.viewportSize()!;
  return !!rect && rect.x>=-1 && rect.y>=-1 && rect.x+rect.width<=viewport.width+1 && rect.y+rect.height<=viewport.height+1;
 }).toBe(true);
 const picker=await page.locator("em-emoji-picker").boundingBox();const panel=await box.boundingBox();
 expect(picker!.width).toBeLessThanOrEqual(panel!.width+2);
 expect(picker!.height).toBeLessThanOrEqual(panel!.height+2);
}

test("emoji popover follows the composer across sidebar and viewport changes",async({peer},info)=>{
 const {page}=await peer("emoji desktop");await page.getByTitle("New Chat").click();await page.getByRole("radio",{name:"Text only",exact:true}).click();
 const trigger=page.getByTitle("Emoji",{exact:true});await trigger.click();await fits(page);
 const triggerBox=await trigger.boundingBox(),panel=await page.getByTestId("emoji-popover").boundingBox();
 expect(Math.abs(panel!.x-triggerBox!.x)).toBeLessThan(2);
 // Resize while open: position must follow the actual anchor, not its old parent.
 for(const width of [280,600]){
  const handle=(await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(handle.x+2,handle.y+100);await page.mouse.down();await page.mouse.move(width,handle.y+100);await page.mouse.up();
  if(!await page.getByTestId("emoji-popover").isVisible()) await trigger.click();
  await fits(page);
 }
 await page.setViewportSize({width:800,height:420});await fits(page);
 await page.locator("em-emoji-picker").getByRole("searchbox").fill("ghost");
 await page.screenshot({path:info.outputPath("emoji-narrow.png")});
 await page.locator("em-emoji-picker").getByRole("button",{name:"👻",exact:true}).first().click();
 await expect(page.getByPlaceholder("Message…")).toHaveValue("👻");await expect(page.getByPlaceholder("Message…")).toBeFocused();
 await trigger.click();await fits(page);
 await page.keyboard.press("Escape");await expect(page.getByTestId("emoji-popover")).toHaveCount(0);
 await trigger.click();await trigger.click();await expect(page.getByTestId("emoji-popover")).toHaveCount(0);
 await trigger.click();await page.getByPlaceholder("Message…").click();await expect(page.getByTestId("emoji-popover")).toHaveCount(0);
});

test("mobile emoji sheet stays visible and supports touch selection and dismissal",async({peer},info)=>{
 const {page}=await peer("emoji phone",{mobile:true,viewport:{width:390,height:844}});
 await page.getByTitle("New Chat").click();await page.getByRole("radio",{name:"Text only",exact:true}).click();await page.getByTitle("Emoji",{exact:true}).tap();await fits(page);
 await page.locator("em-emoji-picker").getByRole("searchbox").fill("ghost");
 await page.screenshot({path:info.outputPath("emoji-phone.png")});
 await page.locator("em-emoji-picker").getByRole("button",{name:"👻",exact:true}).first().tap();
 await expect(page.getByPlaceholder("Message…")).toHaveValue("👻");
 await page.getByTitle("Emoji",{exact:true}).tap();
 await page.locator(".sheet-backdrop").tap({position:{x:10,y:10}});await expect(page.getByTestId("emoji-popover")).toHaveCount(0);
 await page.setViewportSize({width:320,height:480});await page.getByTitle("Emoji",{exact:true}).tap();await fits(page);
 await page.keyboard.press("Escape");await expect(page.getByTestId("emoji-popover")).toHaveCount(0);
});
