import { useCallback, useEffect, useState } from "react";
import { useSettings } from "../contexts/SettingsContext";
import { cleanOwnName, fitsOwnName } from "../lib/ownName";
import { useFittedNameField } from "./useGroupNameField";

/**
 * The "Name in chats" field of Profile and Settings: it shows what is typed, a space between two words included, while
 * each keystroke saves the name cleaned (`cleanOwnName`), as contacts get it; on blur it shows what was saved. Spread
 * on the input: value, ref and handlers.
 */
export function useOwnNameField() {
  const { settings, updateDefaultNickname } = useSettings();
  const saved = settings.defaultNickname;
  const [draft, setDraft] = useState(saved);
  // Changed elsewhere (↻, the other field, another tab): shown, unless it is what is being typed, cleaned.
  useEffect(() => setDraft((typed) => (cleanOwnName(typed) === saved ? typed : saved)), [saved]);
  const change = useCallback((value: string) => { setDraft(value); updateDefaultNickname(value); }, [updateDefaultNickname]);
  const field = useFittedNameField(draft, change, fitsOwnName);
  return { value: draft, ...field, onBlur: () => setDraft(saved) };
}
