import { useEffect, useReducer } from "react";
import { servicesPlatform } from "../lib/platform";

/** The platform's ephemeral services, or null where they are not available yet. Re-renders on change. */
export function useServicesPlatform() {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => servicesPlatform?.subscribe(refresh), []);
  return servicesPlatform;
}
