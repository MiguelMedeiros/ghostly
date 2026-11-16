import { mediaDeniedText } from "./mediaDevices";
import { mediaDeniedOnAndroid } from "../desktop/androidMediaDenied";

/** Why a call did not start or could not use the microphone or camera (`useWebRTC`'s `mediaProblem`): its title and next step. */
const MEDIA_PROBLEM_TEXT = {
  denied: ["calls.mediaDenied", "calls.mediaDeniedNext"],
  unavailable: ["calls.mediaUnavailable", "calls.mediaUnavailableNext"],
  relay: ["calls.relayNoAnswer", "calls.relayNoAnswerNext"],
  relayOnly: ["calls.relayOnlyOff", "calls.relayOnlyOffNext"],
  relayOnlyNow: ["calls.relayOnlyNow", "calls.relayOnlyNowNext"],
} as const;
export type MediaProblem = keyof typeof MEDIA_PROBLEM_TEXT;

/** The title when it was the microphone alone, or the camera alone (the call goes on without video): `mediaProblemOf`. */
const ONE_DEVICE_TITLE = {
  denied: { mic: "calls.micDenied", camera: "calls.cameraDenied" },
  unavailable: { mic: "calls.micUnavailable", camera: "calls.cameraUnavailable" },
} as const;

/**
 * What a call says when it could not use the microphone or camera, as translation keys: the 1:1 call's notice
 * (CallMediaProblem) and a group call's window. Refused in the Android app, the next step is Android's settings
 * (`android`: the notice opens them); on an iPhone or iPad, the Settings app's.
 */
export function mediaProblemKeys(problem: MediaProblem, of: "mic" | "camera" | "both" = "both") {
  const oneDevice = of !== "both" && (problem === "denied" || problem === "unavailable");
  const android = problem === "denied" && mediaDeniedOnAndroid();
  const next = android ? "calls.mediaDeniedAndroid"
    : problem === "denied" && mediaDeniedText() === "settings.media.deniedIos" ? "settings.media.deniedIos"
    : problem === "denied" && oneDevice ? "calls.mediaDeniedOneNext" : MEDIA_PROBLEM_TEXT[problem][1];
  const title = oneDevice ? ONE_DEVICE_TITLE[problem as "denied" | "unavailable"][of as "mic" | "camera"] : MEDIA_PROBLEM_TEXT[problem][0];
  return { title, next, android } as const;
}
