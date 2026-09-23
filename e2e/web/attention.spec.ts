import {test,expect} from "../support/fixtures";

test("notification permission is explicit and independent of persistent sound preference",async({peer})=>{
 const {page}=await peer("preferences");
 await page.addInitScript(()=>{
  class Notice {static permission="default";static async requestPermission(){localStorage.setItem("qa-permission", "requested");this.permission="granted";return "granted";}}
  Object.defineProperty(window,"Notification",{value:Notice,configurable:true});
 });
 await page.goto("/#/settings");await page.reload();
 const sound=page.getByRole("switch",{name:"Notification sounds",exact:true});
 const notice=page.getByRole("switch",{name:"System notifications",exact:true});
 await expect(sound).toBeChecked();await expect(notice).not.toBeChecked();
 expect(await page.evaluate(()=>localStorage.getItem("qa-permission"))).toBeNull();
 await sound.click();await notice.click();await expect(notice).toBeChecked();await expect(sound).not.toBeChecked();
 expect(await page.evaluate(()=>localStorage.getItem("qa-permission"))).toBe("requested");
 await notice.click();await page.reload();await expect(sound).not.toBeChecked();await expect(notice).not.toBeChecked();
});

test("creation marker survives the first offline message and reload",async({peer})=>{
 const {page}=await peer("created");
 await page.getByTitle("New Chat").click();await page.getByRole("radio",{name:"Text only",exact:true}).click();
 const marker=page.getByTestId("chat-created");await expect(marker).toHaveCount(1);
 await expect(marker).not.toContainText("{date}");
 const initial=await marker.locator("time").getAttribute("datetime");expect(Date.parse(initial!)).toBeGreaterThan(0);
 await page.getByPlaceholder("Message…").fill("offline creation check");await page.getByRole("button",{name:"Send message",exact:true}).click();
 await expect(marker).toHaveCount(1);await expect(marker.locator("time")).toHaveAttribute("datetime",initial!);
 await page.reload();await expect(marker).toHaveCount(1);await expect(marker.locator("time")).toHaveAttribute("datetime",initial!);
});

test("background notices are private and live messages do not replay after reload",async({peer})=>{
 const {pair}=await import("../support/paired");const {say,chat}=await import("../support/fixtures");
 const host=await peer("host"),guest=await peer("guest");
 await guest.page.addInitScript(()=>{
  class Notice {
   static permission="granted";
   static async requestPermission(){return "granted";}
   constructor(title:string,options:unknown){const events=JSON.parse(localStorage.getItem("qa-notices")??"[]");events.push({title,options});localStorage.setItem("qa-notices",JSON.stringify(events));}
   close(){} onclick:unknown;
  }
  Object.defineProperty(window,"Notification",{value:Notice});
  document.hasFocus=()=>false;
 });
 await guest.page.reload();
 await guest.page.getByTitle("Settings").click();await guest.page.getByRole("switch",{name:"System notifications",exact:true}).click();
 await expect(guest.page.getByRole("switch",{name:"System notifications",exact:true})).toBeChecked();
 await guest.page.goto("/#/");
 await pair(host,guest);
 await say(host,"private fixture payload");await expect(chat(guest).getByText("private fixture payload",{exact:true})).toBeVisible();
 const notices=()=>guest.page.evaluate(()=>JSON.parse(localStorage.getItem("qa-notices")??"[]"));
 await expect.poll(notices,{timeout:10000}).toHaveLength(1);
 expect(JSON.stringify(await notices())).not.toContain("private fixture payload");
 expect((await notices())[0].options.body).toBe("New message");
 await guest.page.reload();await expect(chat(guest).getByText("private fixture payload",{exact:true})).toBeVisible();
 expect(await notices()).toHaveLength(1);
});

for(const permission of ["denied","unavailable"]){
 test(`notifications honestly expose ${permission}`,async({peer})=>{
  const {page}=await peer(permission);
  await page.addInitScript(value=>{Object.defineProperty(window,"Notification",{value:value==="unavailable"?undefined:class {static permission="denied";static async requestPermission(){return "denied";}}});},permission);
  await page.goto("/#/settings");await page.reload();
  const toggle=page.getByRole("switch",{name:"System notifications",exact:true});await toggle.click();await expect(toggle).not.toBeChecked();
  await expect(page.getByRole("status")).toContainText(permission==="denied"?"blocked":"unavailable");
 });
}
