import { activeProfileId, prefixOf, settingsKeyFor } from "./profiles";
import { listSessions } from "./storage";

/*
 * "What should people call you?", asked once by a new profile (`NameStep`). A profile is new when it is made here: the
 * first start of the app (no settings yet, no chat), or "New profile". A profile restored from a backup, or added to a
 * profile on another device ("I already use Ghostly", "Add this device to another profile"), is not: it is never marked.
 * The mark is a key of its own in the profile's storage, which backups and handoffs leave out (`profileBackup.ts`), so
 * a copy of the profile never carries the question somewhere else.
 */

/** The mark's key, after the profile's prefix. */
export const NAME_STEP_SUFFIX = "name_step";
const markKey = (id: string) => `${prefixOf(id)}${NAME_STEP_SUFFIX}`;

/** Marks profile `id` to ask for a name the next time it shows. */
export function askNameIn(id: string): void {
  try { localStorage.setItem(markKey(id), "ask"); } catch { /* it is not asked */ }
}

/** Whether profile `id` still has to ask for a name. */
export function nameStepPending(id: string = activeProfileId()): boolean {
  try { return localStorage.getItem(markKey(id)) === "ask"; } catch { return false; }
}

/** Takes the mark off: the person gave a name, or skipped. Asked once. */
export function nameStepDone(id: string = activeProfileId()): void {
  try { localStorage.removeItem(markKey(id)); } catch { /* nothing more to do */ }
}

/**
 * The first start of the app in this profile: no settings saved yet and no chat. Run before anything saves the settings
 * (`Root`'s first render, before `SettingsProvider`'s effect), it marks the profile to ask for a name.
 */
export function markFirstStart(): void {
  try {
    const id = activeProfileId();
    if (localStorage.getItem(settingsKeyFor(id)) !== null || listSessions().length > 0) return;
    askNameIn(id);
  } catch { /* not asked */ }
}

/**
 * Tests only: `localStorage["ghostly-test-name-step"]` = "on" asks a new profile for a name even in an automated
 * browser, "off" never.
 */
export const NAME_STEP_TEST_KEY = "ghostly-test-name-step";

/** What the host knows to be a test build (Desktop's e2e bundle id or `GHOSTLY_E2E=1`), set by the host at start. */
let underTest: () => boolean | Promise<boolean> = () => false;
export function setNameStepUnderTest(check: () => boolean | Promise<boolean>): void { underTest = check; }

/**
 * Whether this app asks a new profile for a name: never under test (an automated browser, `navigator.webdriver`, or a
 * test build the host knows), so the suites, which name their peers themselves or not at all, are not stopped by it.
 * The test switch in the storage wins over both, as for a new profile's wallets (`defaultWalletsAllowed`).
 */
export async function nameStepAllowed(): Promise<boolean> {
  let asked: string | null = null;
  try { asked = localStorage.getItem(NAME_STEP_TEST_KEY); } catch { /* no storage here */ }
  if (asked === "off") return false;
  if (asked === "on") return true;
  if (typeof navigator !== "undefined" && navigator.webdriver === true) return false;
  try { return !(await underTest()); } catch { return false; }
}
