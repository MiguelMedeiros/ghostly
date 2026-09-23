/** Native-only adapter is unreachable in browser clients, which use browser permissions. */
export async function isPermissionGranted(): Promise<boolean> { return false; }
export async function requestPermission(): Promise<NotificationPermission> { return "denied"; }
export function sendNotification(): never { throw new Error("Not running in Tauri"); }
