import type { ChangeEvent } from "react";

/**
 * A change to a card's field made a key at a time (typed, deleted, composed), not a paste, a drop or an autofill. A link
 * typed so is half a link at every key: the card reads it once the field is left, not at its scheme's colon.
 */
export const typedByKey = (event: ChangeEvent<HTMLInputElement>) => /^(insertText|insertCompositionText|delete)/.test((event.nativeEvent as InputEvent).inputType ?? "");
