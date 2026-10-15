import { useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";

const subscribe = (listener: () => void) => engine.subscribe(listener);
const snapshot = () => engine.state;
/** The engine's state, re-rendered on every change. What draws identities uses the one in `./identities`. */
export const useEngineState = () => useSyncExternalStore(subscribe, snapshot);
