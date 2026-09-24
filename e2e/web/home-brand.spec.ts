import {test,expect} from "../support/fixtures";
import {pair} from "../support/paired";
test("brand returns home and preserves the conversation and multiline draft",{ tag: ["@feature:app.home", "@feature:chat.paired.draft"] },async({peer})=>{
  const a=await peer("home-brand"),b=await peer("home-peer");await pair(a,b);
  await a.page.getByPlaceholder("Message…").fill("Kept history");await a.page.getByRole("button",{name:"Send message",exact:true}).click();
  await expect(b.page.locator(".chat-wallpaper").getByText("Kept history",{exact:true})).toBeVisible();
  await a.page.getByPlaceholder("Message…").fill("Draft line 1\nDraft line 2");
  const chat=a.page.url();const brand=a.page.getByRole("link",{name:"Go home",exact:true});
  await brand.focus();await brand.press("Enter");await expect(a.page.getByTestId("home-chat-actions")).toBeVisible();
  await a.page.goBack();await expect(a.page).toHaveURL(chat);
  await expect(a.page.getByPlaceholder("Message…")).toHaveValue("Draft line 1\nDraft line 2");
  await expect(a.page.locator(".chat-wallpaper").getByText("Kept history",{exact:true})).toBeVisible();
  await brand.click();await expect(a.page.getByTestId("home-chat-actions")).toBeVisible();
});
