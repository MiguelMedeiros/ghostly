import { setDatabaseName } from "@ghostly/browser/shared/idb";
import { activeProfileId, namespaceOf, setRunningProfile, tabProfileId } from "./profiles";
import { setStorageProfile } from "./storage";
import { loadSettings } from "./settings";
import { applyDocumentLanguage } from "./documentLanguage";

/**
 * This tab's local profile (WISP 04), as an entry point opens it (the one it ran before a reload, else the one last
 * chosen): its storage, its database and its language on
 * `<html>`. Returns the profile's namespace (empty: the default profile, the original names).
 *
 * `recover` points a profile a handoff moved back at its state (`recoverHandoffPointer`) and waits on IndexedDB. The
 * language goes on `<html>` before that wait: an entry module that awaits lets the browser parse the rest of the page
 * and paint, so a language applied after it shows the first paint in English, left to right. Once the wait is over it
 * is applied again, from the namespace the profile points at then.
 */
export async function openProfile(recover: (id: string) => Promise<unknown>): Promise<string> {
  // A reload starts as the profile this tab ran, not the one another tab chose since.
  const kept = tabProfileId();
  if (kept !== undefined) setRunningProfile(kept);
  setStorageProfile(namespaceOf(activeProfileId()));
  applyDocumentLanguage(loadSettings().language);

  await recover(activeProfileId());
  const id = activeProfileId();
  const namespace = namespaceOf(id);
  // This tab stays that profile, even when it waits later and another tab chooses another one meanwhile.
  setRunningProfile(id);
  setStorageProfile(namespace);
  if (namespace) setDatabaseName(`ghostly_${namespace}`);
  applyDocumentLanguage(loadSettings().language);
  return namespace;
}
