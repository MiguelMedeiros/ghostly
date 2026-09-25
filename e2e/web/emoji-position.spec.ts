import {test,expect} from "../support/fixtures";
import type {Page} from "@playwright/test";

/** The emoji/GIF panel is inside the window, and on a wide screen inside the chat's column too. */
async function fits(page:Page){
 const box=page.getByTestId("expression-panel");await expect(box).toBeVisible();
 await expect.poll(async()=>{
  const rect=await box.boundingBox();const viewport=page.viewportSize()!;
  return !!rect && rect.x>=-1 && rect.y>=-1 && rect.x+rect.width<=viewport.width+1 && rect.y+rect.height<=viewport.height+1;
 }).toBe(true);
 if((await box.getAttribute("class"))!.includes("sheet")) return;
 const column=(await page.locator("[data-composer]").boundingBox())!,panel=(await box.boundingBox())!;
 expect(panel.x).toBeGreaterThanOrEqual(column.x-1);
 expect(panel.x+panel.width).toBeLessThanOrEqual(column.x+column.width+1);
 expect(panel.y+panel.height).toBeLessThanOrEqual(column.y+1);
}

test("the emoji/GIF panel follows the composer across sidebar and viewport changes",{ tag: ["@feature:app.emoji-picker", "@feature:app.composer.expressions", "@feature:chat.paired.emoji"] },async({peer},info)=>{
 const {page}=await peer("emoji desktop");await page.getByTitle("New Chat").click();await page.getByRole("radio",{name:"Text only",exact:true}).click();
 const trigger=page.getByTestId("composer-expressions");await trigger.click();await fits(page);
 const panel=page.getByTestId("expression-panel");
 await expect(panel).toHaveAttribute("data-tab","emoji");
 // Resize while open: the panel follows the chat's column, however narrow the chat list leaves it.
 for(const width of [280,600,900]){
  const handle=(await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(handle.x+2,handle.y+100);await page.mouse.down();await page.mouse.move(width,handle.y+100);await page.mouse.up();
  if(!await panel.isVisible()) await trigger.click();
  await fits(page);
 }
 await page.setViewportSize({width:800,height:420});await fits(page);
 await panel.getByTestId("expression-search").fill("ghost");
 await page.screenshot({path:info.outputPath("emoji-narrow.png")});
 await panel.getByTestId("emoji-section-search").getByRole("button",{name:"👻",exact:true}).first().click();
 // The emoji goes in, the message keeps the focus, and the panel stays open for another.
 await expect(page.getByPlaceholder("Message…")).toHaveValue("👻");await expect(page.getByPlaceholder("Message…")).toBeFocused();
 await expect(panel).toBeVisible();
 await page.getByPlaceholder("Message…").click();await expect(panel).toBeVisible();
 await page.keyboard.press("Escape");await expect(panel).toHaveCount(0);
 await trigger.click();await trigger.click();await expect(panel).toHaveCount(0);
 // A click elsewhere in the chat closes it.
 await trigger.click();await page.locator(".chat-wallpaper").click({position:{x:20,y:20}});await expect(panel).toHaveCount(0);
 // Recent emoji come first next time.
 await trigger.click();await expect(panel.getByTestId("emoji-section-recent").getByRole("button",{name:"👻",exact:true})).toBeVisible();
});

test("mobile emoji sheet stays visible and supports touch selection and dismissal",{ tag: ["@feature:app.emoji-picker", "@feature:app.composer.expressions", "@feature:chat.paired.emoji"] },async({peer},info)=>{
 const {page}=await peer("emoji phone",{mobile:true,viewport:{width:390,height:844}});
 await page.getByTitle("New Chat").click();await page.getByRole("radio",{name:"Text only",exact:true}).click();await page.getByTestId("composer-expressions").tap();await fits(page);
 const panel=page.getByTestId("expression-panel");
 await panel.getByTestId("expression-search").fill("ghost");
 await page.screenshot({path:info.outputPath("emoji-phone.png")});
 await panel.getByTestId("emoji-section-search").getByRole("button",{name:"👻",exact:true}).first().tap();
 await expect(page.getByPlaceholder("Message…")).toHaveValue("👻");
 await page.locator(".sheet-backdrop").tap({position:{x:10,y:10}});await expect(panel).toHaveCount(0);
 await page.setViewportSize({width:320,height:480});await page.getByTestId("composer-expressions").tap();await fits(page);
 await page.keyboard.press("Escape");await expect(panel).toHaveCount(0);
});
