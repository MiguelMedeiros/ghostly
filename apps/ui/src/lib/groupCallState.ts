/*
 * The group call's state as `useGroupCall` gives it and the group call window draws it. The same shape as the
 * window's props (`GroupCallView`), kept here until both live on dev, so the hook does not wait on the window.
 */

/** One person in a group call: what they send, and the tracks to show and play. */
export interface GroupCallParticipant {
  identity: string;
  name: string;
  mic: boolean;
  camera: boolean;
  screen: boolean;
  speaking: boolean;
  /** For the window to show and play: the hook attaches none of them to the page itself. */
  tracks: { audio?: MediaStreamTrack | null; camera?: MediaStreamTrack | null; screen?: MediaStreamTrack | null };
}

/** `local` is you; `participants` are everyone else. */
export interface GroupCallState {
  participants: GroupCallParticipant[];
  activeSpeaker: string | null;
  local: GroupCallParticipant;
}
