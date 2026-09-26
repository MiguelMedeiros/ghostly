import {invoke} from "@tauri-apps/api/core";
/** "misplaced": the Desktop app runs from a temporary folder, where macOS gives it no notifications. */
export type NoticePermission = NotificationPermission | "unavailable" | "misplaced";
interface ExtensionNotifications {
  runtime: {id?:string;getURL(path:string):string};
  permissions: {contains(options:{permissions:string[]}):Promise<boolean>;request(options:{permissions:string[]}):Promise<boolean>};
  notifications: {
    create(id:string,options:{type:"basic";iconUrl:string;title:string;message:string;silent:boolean}):Promise<string>;
    clear?(id:string):Promise<boolean>;
    onClicked?:{addListener(listener:(id:string)=>void):void};
  };
}
const extension=()=> {
  const value=(globalThis as unknown as {chrome?:ExtensionNotifications}).chrome;
  return value?.runtime?.id && value.permissions ? value : undefined;
};
const native=()=>"__TAURI_INTERNALS__" in window;
const platform=()=>(navigator as Navigator&{userAgentData?:{platform?:string}}).userAgentData?.platform||navigator.platform||navigator.userAgent;
/** The system settings where the Desktop app's notifications are allowed again, when the app can open them. */
export function noticeSettings():"macos"|"windows"|undefined{
  if(!native()) return undefined;
  return /Mac/i.test(platform())?"macos":/Win/i.test(platform())?"windows":undefined;
}
export async function openNoticeSettings():Promise<void>{
  try{await invoke("open_notification_settings");}catch{/* nothing to open here */}
}

/*
 * A click on a notification opens its chat. Which chat is known only here, by the notification's id: the
 * notification itself carries no chat data.
 */
const chats=new Map<string,string>();
const openers=new Set<(chat:string)=>void>();
let listening=false;
/** Opens the chat of a notification shown from this page; false when it was not. */
function opened(id:string):boolean{
  const chat=chats.get(id);
  if(!chat) return false;
  chats.delete(id);
  window.focus();
  for(const open of openers) open(chat);
  return true;
}
function listen(){
  if(listening) return;
  listening=true;
  if(native()) void import("@tauri-apps/api/event").then(({listen})=>listen<string>("notification-open",({payload})=>opened(payload))).catch(()=>{listening=false;});
  else extension()?.notifications.onClicked?.addListener(id=>{if(opened(id)) void extension()?.notifications.clear?.(id);});
}
/** Called with the chat whose notification was clicked. */
export function onNotificationOpen(open:(chat:string)=>void):()=>void{
  openers.add(open);
  listen();
  return ()=>{openers.delete(open);};
}
export async function notificationPermission():Promise<NoticePermission>{
  try {
    if(native()) {
      const permission=await invoke<NoticePermission|null>("native_notification_permission",{request:false});
      if(permission) return permission;
      return (await (await import("@tauri-apps/plugin-notification")).isPermissionGranted())?"granted":"default";
    }
    const chrome=extension();
    if(chrome) return await chrome.permissions.contains({permissions:["notifications"]})?"granted":"default";
    return typeof Notification==="undefined"?"unavailable":Notification.permission;
  }catch{return "unavailable";}
}
/** Called only from the explicit Settings switch gesture. */
export async function requestNotifications():Promise<NoticePermission>{
  try {
    if(native()) {
      const permission=await invoke<NoticePermission|null>("native_notification_permission",{request:true});
      return permission ?? await (await import("@tauri-apps/plugin-notification")).requestPermission();
    }
    const chrome=extension();
    if(chrome) return await chrome.permissions.request({permissions:["notifications"]})?"granted":"denied";
    return typeof Notification==="undefined"?"unavailable":await Notification.requestPermission();
  }catch{return "unavailable";}
}
/** `chat`: the chat a click opens (a session id, or `group:<id>`); it stays in this page. */
export async function showPrivateNotification(id:string,body:string,chat?:string):Promise<void>{
  if(await notificationPermission()!=="granted") return;
  if(chat){
    chats.set(id,chat);
    // The newest few: an old notification still opens the app, only not a chat.
    if(chats.size>64) chats.delete(chats.keys().next().value as string);
  }
  try {
    if(native()){
      if(await invoke<boolean>("native_private_notification",{id,body})) return;
      (await import("@tauri-apps/plugin-notification")).sendNotification({title:"Ghostly",body,silent:true});
    }else{
      const chrome=extension();
      if(chrome) await chrome.notifications.create(id,{type:"basic",iconUrl:chrome.runtime.getURL("icons/128.png"),title:"Ghostly",message:body,silent:true});
      else {
        const notice=new Notification("Ghostly",{body,tag:id,silent:true});
        notice.onclick=()=>{window.focus();opened(id);notice.close();};
        setTimeout(()=>notice.close(),8000);
      }
    }
  }catch{/* Permission can change between checking and delivery. */}
}
