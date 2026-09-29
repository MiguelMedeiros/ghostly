import { getBrowserHost } from "../host";

/** Stand-ins for `@tauri-apps/api/*`: there is no Tauri in a browser. */
export function invoke(): Promise<never> {
  return Promise.reject(new Error("Not running in Tauri"));
}

export async function getVersion(): Promise<string> {
  return getBrowserHost().version;
}

/** `@tauri-apps/api/event`: no event ever arrives. */
export async function listen(): Promise<() => void> {
  return () => {};
}
