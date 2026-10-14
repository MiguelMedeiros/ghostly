import { useEffect, useState } from "react";

/** A phone held upright: a chat's header keeps the name, a call and ⋮ there, and the rest is in the ⋮ menu. */
export const PHONE_HEADER_QUERY = "(max-width: 480px)";

export function usePhoneHeader(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_HEADER_QUERY).matches);

  useEffect(() => {
    const query = window.matchMedia(PHONE_HEADER_QUERY);
    const onChange = () => setPhone(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return phone;
}
