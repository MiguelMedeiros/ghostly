import type {Page} from "@playwright/test";
/** Isolated browser clipboard; never reads or changes the person's system clipboard. */
export async function setClipboard(page: Page, value: string | null) {
  await page.evaluate(value => {
    Object.defineProperty(navigator, "clipboard", {configurable:true, value:{
      readText: async () => { if(value === null) throw new DOMException("denied","NotAllowedError"); return value; }
    }});
  },value);
}
export async function pasteInvite(page:Page, invite:string) {
  await setClipboard(page,invite);
  await page.getByRole("button",{name:"Paste from clipboard",exact:true}).click();
}
export async function manualFallback(page:Page) {
  await setClipboard(page,null);
  await page.getByRole("button",{name:"Paste from clipboard",exact:true}).click();
}
/** What a Copy button writes, caught in the page: `click` presses it. The browser's clipboard is one for every test running. */
export async function copiedBy(page:Page, click:()=>Promise<void>):Promise<string> {
  await page.evaluate(()=>{
    Object.assign(window,{qaClipboardDescriptor:Object.getOwnPropertyDescriptor(navigator,"clipboard"),qaCopiedInvite:undefined});
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async(value:string)=>{Object.assign(window,{qaCopiedInvite:value});}}});
  });
  try {
    await click();
    await page.waitForFunction(()=>(window as unknown as {qaCopiedInvite?:string}).qaCopiedInvite!==undefined);
    return await page.evaluate(()=>(window as unknown as {qaCopiedInvite:string}).qaCopiedInvite);
  } finally {
    await page.evaluate(()=>{
      const state=window as unknown as {qaClipboardDescriptor?:PropertyDescriptor};
      if(state.qaClipboardDescriptor) Object.defineProperty(navigator,"clipboard",state.qaClipboardDescriptor);
      else Reflect.deleteProperty(navigator,"clipboard");
    });
  }
}
export async function copyInvite(page:Page):Promise<string> {
  await page.evaluate(()=>{
    Object.assign(window,{qaClipboardDescriptor:Object.getOwnPropertyDescriptor(navigator,"clipboard"),qaCopiedInvite:undefined});
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async(value:string)=>{Object.assign(window,{qaCopiedInvite:value});}}});
  });
  try {
    await page.getByTestId("invite-card").getByRole("button",{name:/^(Copy invite|Copied!)$/}).click();
    return await page.evaluate(()=>(window as unknown as {qaCopiedInvite:string}).qaCopiedInvite);
  } finally {
    await page.evaluate(()=>{
      const state=window as unknown as {qaClipboardDescriptor?:PropertyDescriptor};
      if(state.qaClipboardDescriptor) Object.defineProperty(navigator,"clipboard",state.qaClipboardDescriptor);
      else Reflect.deleteProperty(navigator,"clipboard");
    });
  }
}
