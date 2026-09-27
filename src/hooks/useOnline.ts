import { useSyncExternalStore } from "react";

const subscribe = (listener: () => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};
const online = () => navigator.onLine !== false;

/** Whether the device says it has a network. Only "no" is trusted: "yes" can still mean a captive portal. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, online, () => true);
}
