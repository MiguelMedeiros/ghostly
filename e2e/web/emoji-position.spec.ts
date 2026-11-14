import {test,expect} from "../support/fixtures";
import type {Page} from "@playwright/test";
import {iosKeyboard,keyboard} from "../support/keyboard";

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
 const {page}=await peer("emoji desktop");await page.getByTitle("New Chat").click();
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
 // A click anywhere else (here the chat list's empty space) closes it.
 await trigger.click();await expect(panel).toBeVisible();await page.mouse.click(240,300);await expect(panel).toHaveCount(0);
 // Recent emoji come first next time.
 await trigger.click();await expect(panel.getByTestId("emoji-section-recent").getByRole("button",{name:"👻",exact:true})).toBeVisible();
});

test("mobile emoji sheet stays visible and supports touch selection and dismissal",{ tag: ["@feature:app.emoji-picker", "@feature:app.composer.expressions", "@feature:chat.paired.emoji"] },async({peer},info)=>{
 const {page}=await peer("emoji phone",{mobile:true,viewport:{width:390,height:844}});
 await page.getByTitle("New Chat").click();await page.getByTestId("composer-expressions").tap();await fits(page);
 const panel=page.getByTestId("expression-panel");
 await panel.getByTestId("expression-search").fill("ghost");
 await page.screenshot({path:info.outputPath("emoji-phone.png")});
 await panel.getByTestId("emoji-section-search").getByRole("button",{name:"👻",exact:true}).first().tap();
 await expect(page.getByPlaceholder("Message…")).toHaveValue("👻");
 // A tap on the backdrop over the header closes the sheet and nothing else: the chat's Back button is under it.
 const chatHash=await page.evaluate(()=>location.hash);
 await page.locator(".sheet-backdrop").tap({position:{x:10,y:10}});await expect(panel).toHaveCount(0);
 await expect(page.getByTestId("composer-expressions")).toBeVisible();expect(await page.evaluate(()=>location.hash)).toBe(chatHash);
 await page.setViewportSize({width:320,height:480});await page.getByTestId("composer-expressions").tap();await fits(page);
 await page.keyboard.press("Escape");await expect(panel).toHaveCount(0);
 // On its side the sheet keeps room for emoji under its categories, search and switch: a whole row shows.
 await page.setViewportSize({width:568,height:320});await page.getByTestId("composer-expressions").tap();await fits(page);
 await expect.poll(async()=>{
  const strip=(await panel.locator(".expression-scroll").boundingBox())!;
  const first=(await panel.locator(".expression-scroll .emoji-cell").first().boundingBox())!;
  return first.y>=strip.y-1 && first.y+first.height<=strip.y+strip.height+1;
 }).toBe(true);
 await page.screenshot({path:info.outputPath("emoji-phone-landscape.png")});
});

/**
 * A short screen with the keyboard up for the panel's search (iOS's keyboard: only the visual viewport gets shorter):
 * the grabber, the categories, the search and the switch left the results 8 px and no emoji on a phone on its side,
 * and one row on the smallest phone upright. The panel goes compact there, the switch beside the search, and two whole
 * rows of 44 px emoji show above the keyboard. A phone upright with room for two rows keeps the usual panel.
 */
test.describe("emoji search with the keyboard up",()=>{
 const cases=[
  {name:"a phone on its side",width:667,height:375,keys:200,compact:true,rows:2},
  {name:"two panes on a phone on its side",width:874,height:402,keys:240,compact:true,rows:2},
  {name:"the smallest phone upright",width:320,height:568,keys:253,compact:true,rows:2},
  {name:"a phone upright",width:375,height:667,keys:260,compact:false,rows:2},
 ];
 for(const c of cases){
  test(`${c.name} (${c.width}×${c.height}, ${c.keys} px keyboard): whole rows of emoji above the keyboard`,{ tag: ["@feature:app.emoji-picker", "@feature:app.composer.expressions", "@feature:app.mobile-layout"] },async({peer},info)=>{
   const {page}=await peer("emoji keyboard",{mobile:true,viewport:{width:c.width,height:c.height}});
   await iosKeyboard(page);
   await page.getByTitle("New Chat").click();await page.getByTestId("composer-expressions").tap();
   const panel=page.getByTestId("expression-panel");await expect(panel).toBeVisible();
   const search=panel.getByTestId("expression-search");
   await search.focus();await keyboard(page,c.keys);
   await expect(page.locator("html")).toHaveAttribute("data-keyboard","true");
   await search.fill("face");
   const visible=c.height-c.keys;
   if(c.compact) await expect(panel).toHaveAttribute("data-compact","true");
   else await expect(panel).not.toHaveAttribute("data-compact");
   // The panel, its search and its switch between the top of the screen and the keyboard.
   await expect.poll(async()=>{const r=(await panel.boundingBox())!;return r.y>=-1 && r.y+r.height<=visible+1;}).toBe(true);
   const field=(await search.boundingBox())!,tab=(await panel.getByTestId("expression-tab-gif").boundingBox())!;
   expect(field.y).toBeGreaterThanOrEqual(0);expect(tab.y+tab.height).toBeLessThanOrEqual(visible+1);
   if(c.compact){
    // Beside the search, and no grabber or categories over it.
    expect(tab.y).toBeLessThan(field.y+field.height);expect(tab.y+tab.height).toBeGreaterThan(field.y);
    await expect(panel.locator(".expression-categories")).toBeHidden();
    expect(await panel.evaluate((el)=>getComputedStyle(el,"::before").display)).toMatch(/none|^$/);
   }else{
    await expect(panel.locator(".expression-categories")).toBeVisible();
   }
   // Whole rows of 44 px emoji in the results, above the keyboard.
   await expect.poll(()=>panel.locator(".expression-scroll").evaluate((strip,bottom)=>{
    const shown=strip.getBoundingClientRect(),rows=new Set<number>();
    for(const cell of strip.querySelectorAll(".emoji-cell")){
     const r=cell.getBoundingClientRect();
     if(r.height>=43.5 && r.top>=shown.top-1 && r.bottom<=shown.bottom+1 && r.bottom<=bottom+1) rows.add(Math.round(r.top));
    }
    return rows.size;
   },visible)).toBeGreaterThanOrEqual(c.rows);
   await page.screenshot({path:info.outputPath(`emoji-keyboard-${c.width}x${c.height}.png`)});
   // Keyboard down: the usual panel again.
   await search.blur();await keyboard(page,0);
   await expect(page.locator("html")).toHaveAttribute("data-keyboard","false");
   await expect(panel).not.toHaveAttribute("data-compact");
  });
 }
});
