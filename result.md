# Android: chats and groups stay connected in the background

## PR body draft

**In the released version: yes** (every Android release since the app shipped: out of sight, Android freezes the app and every link drops).

### What

The Android app keeps chats and groups connected while it is in the background, so on return they are already "Connected" instead of reconnecting (or waiting for Reconnect).

- **`ConnectionService.kt`**: a foreground service with a quiet, low-importance "Ghostly is connected" notification on its own "Connection" channel (no sound, no badge, a tap opens the app; text in the 8 languages). Type `remoteMessaging` on Android 14+ (`FOREGROUND_SERVICE_REMOTE_MESSAGING`, no runtime prerequisites, no daily time limit unlike `dataSync`); no type below 14, where none is required. Started only with the app in front; ends with the app's task (swipe away).
- **Wake lock**: partial, only while a chat's link or a group member's edge is open, taken as a 15-minute lease that the page renews every 5 minutes: if the page ever stops renewing, the lock runs out by itself. Released as soon as no link is up.
- **One notification with `TransferService`** (`ConnectionHolds.kt`): while the connection service runs, files that move are held by it (its line switches to "Sending and receiving files"), and it stays up for files still moving after it was let go (so no foreground-service start is needed from the background). When it is off, `TransferService` holds files as before.
- **Setting**: Settings → Notifications → "Stay connected in the background", **on by default**, with a line on battery; found by the settings search. It is this device's setting (local storage), not the profile's. Off: today's behaviour.
- **Stops** when the switch is off, the app is locked, Ghostly's own Online switch is off (or a limited start), there is no chat or group, or the profile closes (sign out / switch profile).
- **Battery prompt only after a kill**: never on first run. If the system ended the app while the service ran (the service never stopped, and on Android 11+ the last exit reason is the system's: low memory, freezer, signal, other; not a force stop, crash, update or permission change) and the app's battery use is still optimized, the next start says so once, above the chat list and on the switch's row, with "Open settings" to the app's page (Battery → Unrestricted). It uses the app-details page, not `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (a Play-restricted permission).
- WebView timers: no change needed. wry never calls `pauseTimers`/`WebView.onPause`, and the A0 measurement (docs/ANDROID.md) already saw 60/60 JS ticks with the screen off; what stopped the links was the process being frozen, which the foreground service prevents.

### Play policy

Android's description of `remoteMessaging`: "Transfer text messages from one device to another. Assists with continuity of a user's messaging tasks when they switch devices." Ghostly's use (keeping a peer-to-peer messenger's links up so messages move between the user's device and contacts' devices) is close to this but not the textbook case. **Play Console** (Policy → App content → Foreground service permissions) needs the `remoteMessaging` declaration with a short video of the notification and the feature. If Play reviewers refuse it, the fallback is `specialUse` with `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` ("peer-to-peer messaging: keeps end-to-end links to the user's contacts open while in the background"), a one-line manifest change plus the constant in `ConnectionService.kt`.

### Measurements (API 35 x86_64 emulator, debug build)

`e2e/android/backgroundConnected.spec.ts` (the debug APK, a web peer in Chromium on this machine, WebRTC): Home for the given time while the web peer checks the chat every 10 s, then back to the app. "Off" is the same APK with the switch off, which is exactly the code path before this PR (no service).

| Away (Home) | Switch on: web peer saw it connected | on: Connected after return | Switch off (before): web peer saw it connected | off: Connected after return |
|---|---|---|---|---|
| 1 min | 6/6 checks | 30 ms | 2/6 (gone at 20-30 s) | 309 ms |
| 5 min | 30/30 | 110 ms | 2/30 | 1974 ms |
| 15 min | 90/90 | 149 ms | 2/90 | 1926 ms |
| 30 min | 180/180 | 142 ms | 2/180 | 3457 ms |

Process state while away: on, the app and the WebView renderer at oom adj 50 (foreground service); off, adj 700 (cached). The emulator never froze the app in either case (known: this AVD does not run the cached-apps freezer), so on a phone "off" is worse than this: the frozen app also has to thaw and redial.

Battery, 30 min idle out of sight on battery power (`dumpsys battery unplug`, `batterystats --reset` before each half), per app uid:

| | Switch on | Switch off |
|---|---|---|
| Process state | Fg Service 29m 59s | Cached 29m 59s |
| App uid CPU | 7.95 s (6.36 s user + 1.59 s kernel; renderer 4.71 s, app 3.03 s) | 12.11 s (9.98 s + 2.13 s; renderer 5.59 s, app 6.23 s) |
| Chat connected at the end | yes | no |
| `ghostly:connection` wake lock | listed as held | none |

The emulator's power model reports 0 mAh for everything and does not tally the duration of a partial wake lock taken before the reset, so these numbers cannot say what the wake lock costs. Off used more CPU here because the unfrozen app keeps redialing a link that dropped; on a phone a cached app is frozen and uses close to none. **The real battery cost on a phone is the partial wake lock keeping the CPU out of suspend while a link is up: measure on a phone before release** (see Doubts).

Not measured: a 3-member group and a CLI bot as the contact. The Android e2e harness pairs the app with web peers only; a group needs a group flow with two web peers that the harness does not have yet. Group edges go through the same service (the same process is kept up), and `connectionNeed` counts an open group edge as a live link (unit-tested).

### Tests

- UI: `apps/ui/src/test/app/stayConnected.test.tsx` (7): when it is wanted (online, chats or groups, not an invitation or a lost group, not a limited start) and when a link is up; held by default and told of links coming and going; let go with no chat, offline, with the switch off, and when the profile closes; told again every 5 minutes; the "Android stopped Ghostly" notice above the list and on the row, with Open settings; nothing outside the Android app.
- Kotlin: `ConnectionHoldsTest.kt` (6): never both services; files under the connection service when on, under the transfer service when off or refused; a connection let go while files move stays until they are through; the wake lock's lease; which exit reasons count as the system's.
- Rust: `nothing_stays_connected_on_a_desktop` (the command answers `{ held: false, killed: false }` off Android), plus the existing command-list checks.
- e2e (gated, Android emulator): `e2e/android/backgroundConnected.spec.ts`: on, the service is in the foreground as `remoteMessaging` (types 0x200), the app never freezes, the web peer sees the chat connected all along, Connected within 5 s of return; off, the service stops. An opt-in battery test (`E2E_ANDROID_BATTERY_S`).
- `e2e/features.json`: `android.background.connected`.

---

## Session notes

### Tests and commands run
- `npx vitest run -c apps/ui/vitest.ui.config.ts --maxWorkers=2` on the new test, keepAwake, androidCallService, settingsSections, androidHost: 60/60. Earlier, the related set (settings search, i18n, shell, layout and App-rendering tests): 32 files, 1217/1217.
- `npm run typecheck`: clean. `npx tsc --noEmit -p e2e`: clean. `npx eslint` on every changed TS/TSX file: clean.
- `npm run locales:sort`: 8 files sorted. `npm run test:map -- --summary`: 686 features, 684 with a test (the same 2 as before without one). `node tools/scripts/changes.mjs`: well formed.
- `heavy cargo test --lib -- commands::`: 21/21; `-- alphabetical command`: 40/40 (command lists, capabilities, permission files).
- `heavy npm run tauri -- android build --debug --apk --target x86_64`: built (the Kotlin compiles). `heavy gradlew :app:testUniversalDebugUnitTest`: 71/71 (ConnectionHoldsTest 6/6).
- e2e on the emulator: the spec at 1, 5, 15 and 30 min (on and off each): all passed; battery 30 min: passed.

### Red before
This is a new feature, so the unit tests had nothing to run against before (their modules did not exist). The real "before" is the switch-off run above: same APK, the code path dev has today, link gone 20-30 s after Home every time.

### Doubts
- **Wake lock and battery.** Following the brief, a partial wake lock is held whenever any link is up. On a phone that probably means the CPU never suspends while a chat is connected, which is the main battery cost and the emulator cannot measure it. The foreground service alone already keeps the app unfrozen and lets its network through Doze; without the wake lock the CPU would sleep between Doze windows and links might drop on long idle anyway. Worth a 1-night phone test with and without the wake lock before release.
- **Play review of `remoteMessaging`** (see Play policy above): it is the closest type but not a perfect match; `specialUse` is the fallback.
- **Notifications not allowed**: on Android 13+ with notifications never allowed (a fresh install), the service runs but its notification is not shown (it appears only in the system's active-apps list). The app does not ask for the permission for this; it asks only from Settings or at a call, as today.
- **`result.md` is a tracked file on dev** (a stale report from an old website PR). I wrote this report over it as the brief asks; it should not be committed with the PR (restore it with `git checkout result.md`, or delete it from dev separately).
- The lab script that drove the emulator runs is in `test-results/keepalive-lab/` (ignored by git).
