import {invoke} from "@tauri-apps/api/core";
export type NoticePermission = NotificationPermission | "unavailable";
interface ExtensionNotifications {
  runtime: {id?:string;getURL(path:string):string};
  permissions: {contains(options:{permissions:string[]}):Promise<boolean>;request(options:{permissions:string[]}):Promise<boolean>};
  notifications: {create(id:string,options:{type:"basic";iconUrl:string;title:string;message:string;silent:boolean}):Promise<string>};
}
const extension=()=> {
  const value=(globalThis as unknown as {chrome?:ExtensionNotifications}).chrome;
  return value?.runtime?.id && value.permissions ? value : undefined;
};
const native=()=>"__TAURI_INTERNALS__" in window;
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
export async function showPrivateNotification(id:string,body:string):Promise<void>{
  if(await notificationPermission()!=="granted") return;
  try {
    if(native()){
      if(await invoke<boolean>("native_private_notification",{id,body})) return;
      (await import("@tauri-apps/plugin-notification")).sendNotification({title:"Ghostly",body,silent:true});
    }else{
      const chrome=extension();
      if(chrome) await chrome.notifications.create(id,{type:"basic",iconUrl:chrome.runtime.getURL("icons/128.png"),title:"Ghostly",message:body,silent:true});
      else {
        const notice=new Notification("Ghostly",{body,tag:id,silent:true});
        notice.onclick=()=>{window.focus();notice.close();};
        setTimeout(()=>notice.close(),8000);
      }
    }
  }catch{/* Permission can change between checking and delivery. */}
}
