import {test,expect} from "../support/fixtures";
import {pair} from "../support/paired";
test("profile name is optional, editing and clearing persist, and a cleared name reaches the contact",{tag:["@feature:profiles.name-optional","@feature:chat.paired.nickname-sync"]},async({peer})=>{
  const a=await peer("optional-name"),b=await peer("named-contact");
  // The profile is a page beside the list; opening it twice would toggle back.
  const openProfile=async()=>{if(!await a.page.getByTestId("profile-page").isVisible())await a.page.getByTestId("account-profile").click();};
  const closeProfile=()=>a.page.goBack();
  await openProfile();
  const input=a.page.getByTestId("account-nickname");
  await expect(input).toHaveValue("");
  await expect(a.page.getByText("This name will be used as default in new chats")).toHaveCount(0);
  await input.fill("Chosen name");
  await a.page.reload();await openProfile();
  await expect(input).toHaveValue("Chosen name");
  await closeProfile();
  await pair(a,b);
  await a.page.getByPlaceholder("Message…").fill("Named introduction");
  await a.page.getByRole("button",{name:"Send message",exact:true}).click();
  await expect(b.page.locator(".chat-wallpaper").getByText("Named introduction",{exact:true})).toBeVisible();
  await expect(b.page.getByTestId("sidebar").getByText("Chosen name",{exact:true})).toBeVisible();
  await openProfile();await input.fill("");
  await closeProfile();
  await a.page.getByPlaceholder("Message…").fill("An unnamed message");
  await a.page.getByRole("button",{name:"Send message",exact:true}).click();
  await expect(b.page.locator(".chat-wallpaper").getByText("An unnamed message",{exact:true})).toBeVisible();
  const nick=await b.page.evaluate(()=>Object.entries(localStorage).flatMap(([k,v])=>{try{return k.startsWith("ghostly_") ? JSON.parse(v).messages??[]:[];}catch{return [];}}).find(m=>m.text==="An unnamed message")?.nick);
  expect(nick??"").toBe("");
  // Cleared is said to the contact too: no stale name stays behind, only the steady unnamed one.
  await expect(b.page.getByTestId("sidebar").getByText(/^Contact · \S{6}$/)).toBeVisible();
  await expect(b.page.getByTestId("sidebar").getByText("Chosen name",{exact:true})).toHaveCount(0);
  await a.page.reload();await openProfile();
  await expect(input).toHaveValue("");
  await expect(a.page.getByTestId("account-profile")).toHaveAccessibleName(/Anonymous/);
});
