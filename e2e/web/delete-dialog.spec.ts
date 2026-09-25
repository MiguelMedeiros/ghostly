import { manualFallback } from "../support/clipboard";
import { expect, openProfilePage, test } from "../support/fixtures";
test.setTimeout(30000);
test("delete dialog cancels safely and keeps its target through a reorder",{ tag: ["@feature:chats.list.delete", "@feature:app.popovers"] },async({peer})=>{
  const {page}=await peer("delete-dialog");
  await page.getByRole("button",{name:"New chat",exact:true}).click();const first=page.url().split('/').at(-1)!;
  await page.getByRole("button",{name:"New chat",exact:true}).click();const selected=page.url();
  const trash=page.getByRole("button",{name:"Delete chat",exact:true}).nth(1);
  await trash.focus();await trash.click();
  const dialog=page.getByRole("dialog",{name:"Delete chat?",exact:true});
  await expect(dialog).toBeVisible();await expect(dialog.getByRole("button",{name:"Cancel"})).toBeFocused();
  await expect(page).toHaveURL(selected);
  await page.keyboard.press("Shift+Tab");await expect(dialog.getByRole("button",{name:"Delete chat",exact:true})).toBeFocused();
  await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(trash).toBeFocused();
  await trash.click();await page.mouse.click(2,2);await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Delete chat",exact:true})).toHaveCount(2);
  await trash.click();
  await page.evaluate(id=>{localStorage.setItem(`ghostly_pin_${id}`,"1");window.dispatchEvent(new Event("session-updated"));},first);
  await dialog.getByRole("button",{name:"Delete chat",exact:true}).click();
  await expect(page).toHaveURL(selected);
  expect(await page.evaluate(id=>[localStorage.getItem(`ghostly_${id}`),localStorage.getItem(`ghostly_pin_${id}`)],first)).toEqual([null,null]);
  await page.getByRole("button",{name:"Options",exact:true}).click();
  await page.getByRole("button",{name:"Delete chat",exact:true}).last().click();
  await dialog.getByRole("button",{name:"Delete chat",exact:true}).click();
  await expect(page).not.toHaveURL(selected);
  await expect(page.getByRole("button",{name:"Delete chat",exact:true})).toHaveCount(0);
});

for(const mobile of [false,true]) test(`popup outside gestures close safely (mobile=${mobile})`,{ tag: ["@feature:app.popovers"] },async({peer})=>{
  const {page}=await peer(`dismiss-${mobile}`,{mobile});
  await page.getByRole("button",{name: "Join chat", exact: true}).first().click();
  const dialog=page.getByRole("dialog",{name:"Join a chat"});
  await manualFallback(page);
  await page.getByPlaceholder("Paste invite…").fill("draft stays while inside");
  const r=(await dialog.boundingBox())!;
  await page.mouse.move(r.x+20,r.y+20);await page.mouse.down();await page.mouse.move(2,2);await page.mouse.up();
  await expect(dialog).toBeVisible();
  if(mobile) await page.touchscreen.tap(2,2);else await page.mouse.click(2,2);
  await expect(dialog).toHaveCount(0);
  if(!mobile){
    // The profile is a page beside the list now, not a popup: Back leaves it.
    await openProfilePage(page);await expect(page.getByTestId("account-nickname")).toBeVisible();
    await page.getByTestId("account-nickname").click();await expect(page.getByTestId("account-nickname")).toBeVisible();
    await page.getByRole("button",{name:"Back",exact:true}).click();await expect(page.getByTestId("account-nickname")).toHaveCount(0);
  }
});

test("the connection panel opens by keyboard, has both keys, and dismisses without changing the chat", { tag: ["@feature:chat.paired.status", "@feature:app.popovers"] }, async ({peer}) => {
  const {page} = await peer("connection-details");
  await page.getByRole("button", {name:"New chat", exact:true}).click();
  const route = page.url();
  const trigger = page.getByTestId("connection-options");
  await expect(trigger).not.toHaveAttribute("title");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", {name:"Connection options"});
  await expect(panel).toBeVisible();
  // Both keys, whole and copyable: this side's and the contact's, whose short form is in the header.
  await expect(panel.getByText("You", {exact:true})).toBeVisible();
  await expect(panel.getByText("Contact", {exact:true})).toBeVisible();
  const key = (await panel.getByTestId("connection-key-contact").textContent())!;
  expect(key.length).toBeGreaterThan(40);
  await expect(trigger.getByTestId("connection-key")).toHaveText(`${key.slice(0, 6)}...${key.slice(-6)}`);
  await expect(panel.getByTestId("connection-key-you")).not.toHaveText(key);
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(panel).toBeVisible();
  await page.mouse.click(2,2);
  await expect(panel).toBeHidden();
  await expect(page).toHaveURL(route);
});
