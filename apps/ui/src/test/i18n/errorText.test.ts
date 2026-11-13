import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_ERRORS, engineText, type EngineErrorCode } from "@ghostly/core";
import { ERROR_RULES, errorText, knownErrorParts, knownErrorText, rawError } from "../../lib/errorText";
import { english } from "../../lib/english";
import { failedReason, failedStatus } from "../../lib/fileStatus";
import { problemLine, problemText, sentences } from "../../lib/problemText";
import { liveAttemptText } from "../../lib/transportEvents";
import type { TranslationKey } from "../../contexts/I18nContext";
import { translateWith } from "../../locales/translate";
import { LANGUAGES, LOCALES } from "./locales";

// covers: app.i18n

/*
 * Errors thrown in English by the engine, the platform layer, the extension and the app's own helpers, said in the
 * app's language (lib/errorText.ts). Each sample is a message as its source throws it, and names that source: a
 * reworded message there would no longer match its rule, and would show in English again unnoticed.
 */

const ROOT = join(fileURLToPath(import.meta.url), "../../../../../..");
const source = (path: string) => readFileSync(join(ROOT, path), "utf8");

const BROWSER = "packages/browser/src";
const CORE = "packages/core/src";
const ANDROID_APP = "apps/desktop/gen/android/app/src/main/java/tools/ghostly/app";
/** The engine's known errors, written once with their codes (@ghostly/core ENGINE_ERRORS) and thrown from there. */
const CODES = "packages/core/src/engineErrors.ts";
/**
 * Why a contact's proof failed this app's check, as its verify path throws it (proofs/verify.ts, the providers' verify(),
 * core identityProofs.ts onPresent), and the refusals a contact's app sends back for mine. Shown under the share in the
 * chat and on the back of the contact's card: they were English in every language.
 */
/**
 * A check that could not run (IdentityCheckUnavailable: a host, resolver or relay down or unreachable): it says nothing
 * about the proof, so it never reads "This proof couldn't be verified" (agents#3781).
 */
const PROOF_UNAVAILABLE: readonly (readonly [string, string, string?])[] = [
  ["github.com could not be reached: Failed to fetch", `${BROWSER}/proofs/sshForges.ts`, "`${host} could not be reached: ${"],
  ["github.com answered HTTP 502", `${BROWSER}/proofs/sshForges.ts`, "`${host} answered HTTP ${response.status}`"],
  ["Unexpected answer from github.com", `${BROWSER}/proofs/sshForges.ts`, "`Unexpected answer from ${host}`"],
  ["The account's server (bsky.social) could not be reached", `${BROWSER}/proofs/providers/atproto.ts`, "`The account's server (${hostOf(doc.pds)}) could not be reached`"],
  ["The account's server (bsky.social) did not send the record", `${BROWSER}/proofs/providers/atproto.ts`, "`The account's server (${hostOf(doc.pds)}) did not send the record`"],
  ["The account's server bsky.social was not contacted: Failed to fetch", `${BROWSER}/proofs/atproto/resolve.ts`, "`The account's server ${host} was not contacted: ${"],
  ["The homeserver homeserver.pubky.app answered 502", `${BROWSER}/proofs/pubky.ts`, "`The homeserver ${host} answered ${r.status}`"],
  ["The homeserver homeserver.pubky.app could not be reached", `${BROWSER}/proofs/pubky.ts`, "`The homeserver ${host} could not be reached`"],
  ["The homeserver homeserver.pubky.app was not contacted: Failed to fetch", `${BROWSER}/proofs/pubky.ts`, "`The homeserver ${host} was not contacted: ${"],
  ["The homeserver homeserver.example answers on port 8443; only port 443 is contacted", `${BROWSER}/proofs/pubky.ts`, "`The homeserver ${host} answers on port ${port}; only port 443 is contacted`"],
  ["example.org could not be reached. It must serve https://example.org/.well-known/did.json over HTTPS, without a redirect, with the header Access-Control-Allow-Origin: *", `${BROWSER}/proofs/did.ts`, "`${host} could not be reached. It must serve ${url} over HTTPS, without a redirect, with the header Access-Control-Allow-Origin: *`"],
  ["example.org answered with a redirect; it must serve exactly https://example.org/.well-known/did.json", `${BROWSER}/proofs/did.ts`, "`${host} answered with a redirect; it must serve exactly ${url}`"],
  ["example.org answered 503 for https://example.org/.well-known/did.json", `${BROWSER}/proofs/did.ts`, "`${host} answered ${response.status} for ${url}`"],
  ["Cloudflare could not resolve _ghostly.example.org", `${BROWSER}/proofs/domain.ts`, "`${resolver.name} could not resolve ${name}`"],
  ["Cloudflare sent an unusable answer", `${BROWSER}/proofs/domain.ts`, "`${resolver.name} sent an unusable answer`"],
  ["Quad9 sent an answer that is too large", `${BROWSER}/proofs/domain.ts`, "`${resolver.name} sent an answer that is too large`"],
  ["No Pkarr relay answered for this did:dht", `${CORE}/didDht.ts`],
  ["No Pkarr relay to ask", `${CORE}/didDht.ts`],
  ["Hide my IP from contacts is on: pds.example.org, a server your contact chose, was not contacted", `${BROWSER}/engine/identities.ts`, "`Hide my IP from contacts is on: ${refused}, a server your contact chose, was not contacted`"],
];
const PROOF_REASONS: readonly (readonly [string, string, string?])[] = [
  ["GitHub has no account octocat-old", `${BROWSER}/proofs/providers/ssh.ts`, "`${label} has no account ${login}`"],
  ["GitLab has no account someone", `${BROWSER}/proofs/providers/ssh.ts`, "`${label} has no account ${login}`"],
  ["api.github.com is limiting lookups; check again later", `${BROWSER}/proofs/sshForges.ts`, "`${host} is limiting lookups; check again later`"],
  ["example.com answered 404", `${BROWSER}/proofs/domain.ts`, "`${domain} answered ${response.status}`"],
  ["example.com answered with a redirect; the file must be served at exactly https://example.com/.well-known/ghostly.json", `${BROWSER}/proofs/domain.ts`, "`${domain} answered with a redirect; the file must be served at exactly ${url}`"],
  ["The record is no longer in the account's repository", `${BROWSER}/proofs/providers/atproto.ts`],
  ["The account is no longer on its server", `${BROWSER}/proofs/providers/atproto.ts`],
  ["The account's DID is not registered, or was deactivated", `${BROWSER}/proofs/atproto/resolve.ts`],
  ["The account's DID no longer resolves: example.com has no address", `${BROWSER}/proofs/atproto/resolve.ts`, "`The account's DID no longer resolves: ${e.message}`"],
  ["The account's DID could not be resolved", `${BROWSER}/proofs/atproto/resolve.ts`],
  ["This DID is deactivated: its owner retired it", `${BROWSER}/proofs/did.ts`],
  ["The proof file is not on the homeserver", `${BROWSER}/proofs/providers/pubky.ts`],
  ["The file on the homeserver is not this proof", `${BROWSER}/proofs/providers/pubky.ts`],
  ["This Pubky key has no records on the Pkarr relays", `${BROWSER}/proofs/pubky.ts`],
  ["The homeserver of this Pubky key has no records on the Pkarr relays", `${BROWSER}/proofs/pubky.ts`],
  ["This Pubky key names no homeserver", `${BROWSER}/proofs/pubky.ts`],
  ["Signed by another Nostr key", `${BROWSER}/proofs/providers/nostr.ts`],
  ["Signed by another SSH key", `${BROWSER}/proofs/providers/ssh.ts`],
  ["Invalid Nostr signature", `${BROWSER}/proofs/providers/nostr.ts`],
  ["The evidence is for another identity", `${BROWSER}/proofs/verify.ts`],
  ["This app cannot verify this kind of identity", `${BROWSER}/proofs/verify.ts`],
  ["The proof lasts longer than this kind of identity allows", `${BROWSER}/proofs/verify.ts`],
  ["Offline: this identity cannot be checked now", `${BROWSER}/proofs/verify.ts`],
  ["The proof is dated in the future", `${CORE}/identityProofs.ts`],
  ["The proof key did not sign this conversation's challenge", `${CORE}/identityProofs.ts`],
  ["Its owner revoked this proof", `${CORE}/identityProofs.ts`],
  ["The proof has expired", `${CORE}/identityProofs.ts`],
  ["Your contact's app cannot verify this kind of identity yet", `${CORE}/identityProofs.ts`],
  ["Your contact's app could not check it. Try again later.", `${CORE}/identityProofs.ts`],
  ["Your contact keeps too many identities from you already", `${CORE}/identityProofs.ts`],
  ["That identity is no longer in your profile", `${CORE}/identityProofs.ts`],
  ["Your contact could not verify it", `${CORE}/identityProofs.ts`],
  ...PROOF_UNAVAILABLE,
];

/** [message as thrown, the file that throws it, the part of the message written there as it is]. */
const SAMPLES: readonly (readonly [string, string, string?])[] = [
  ["The Ghostly peer did not start. Reopen the extension to retry.", "apps/extension/src/background.ts"],
  ["The membership history forked. Membership changes are halted; the admin must re-form the group.", "packages/core/src/groupSession.ts", "Membership changes are halted; the admin must re-form the group."],
  ["The membership history forked", "packages/browser/src/engine/groups.ts"],
  // What every call outside LIMITED_MODE_METHODS is answered with in limited mode (engine/server.ts): a file, a group, a device action.
  ["Ghostly could not check which device is active yet. This works once it can.", "packages/browser/src/engine/node.ts"],
  ["Listener given to a chat in use: this one was quiet. Open this chat to take one back; your messages and transport identity are saved.", "packages/browser/src/engine/node.ts"],
  ["Listener released for another chat. Open this chat to restore it; your messages and transport identity are saved.", "packages/browser/src/engine/node.ts"],
  ["Native adapter could not start. Reopen this chat to retry.", "packages/browser/src/engine/node.ts"],
  ["At most 64 items can wait for this contact. Wait until some are picked up.", `${BROWSER}/engine/hold.ts`, " items can wait for this contact. Wait until some are picked up."],
  ["Items waiting for this contact would exceed 64 MB. Wait until some are picked up.", `${BROWSER}/engine/hold.ts`, "Items waiting for this contact would exceed ${"],
  ["Message exceeds 16384 UTF-8 bytes.", "packages/browser/src/engine/node.ts", "Message exceeds ${LIMITS.maxChatMessageBytes} UTF-8 bytes."],
  ["Message exceeds 4096 UTF-8 bytes.", "packages/browser/src/engine/groupEdits.ts", "Message exceeds ${GROUP_EDIT_TEXT_BYTES} UTF-8 bytes."],
  ["Message too long once encoded. Shorten it or send it as a file.", `${CORE}/ghostlink.ts`],
  ["This message was edited 100 times, the most one takes.", "packages/browser/src/engine/node.ts", "This message was edited ${most} times, the most one takes."],
  ["That message is not in this chat, or cannot be replied to", "packages/browser/src/engine/node.ts"],
  ["That message cannot be replied to", "packages/browser/src/engine/node.ts"],
  ["That message is not in this chat", "packages/browser/src/engine/node.ts"],
  ["No message to forward", "packages/browser/src/engine/node.ts"],
  ["There is no room left on this device for a new chat", "apps/ui/src/lib/storage.ts"],
  // Any engine call whose storage write the browser refused for want of space (engine/server.ts): Chromium's message is empty.
  ["Not enough space on this device (QuotaExceededError)", `${BROWSER}/shared/idb.ts`, "Not enough space on this device ("],
  ["Not enough space on this device (QuotaExceededError: The quota has been exceeded.)", `${BROWSER}/shared/idb.ts`, "Not enough space on this device ("],
  ["Not enough space on this device (No space left on device (os error 28))", `${BROWSER}/engine/forwards.ts`, "Not enough space on this device ("],
  // A part that loads on demand whose file did not come (offline before the worker kept it, or a deploy replaced it under
  // an open tab): the browser's own words, Chromium's, WebKit's and Firefox's. The part written there is the load.
  ["Failed to fetch dynamically imported module: https://app.ghostly.tools/assets/index-AbC123.js", `${BROWSER}/engine/wallet.ts`, 'import("@cashu/cashu-ts")'],
  ["Importing a module script failed.", `${BROWSER}/engine/paymentAdapters/providers/nwcProvider.ts`, 'await import("./nwc")'],
  ["error loading dynamically imported module: https://app.ghostly.tools/assets/bitcoind-AbC123.js", `${BROWSER}/engine/paymentAdapters/providers/bitcoindProvider.ts`, 'await import("./bitcoind")'],
  ["Someone else joined with this invite first. Ask your contact for a new one.", "packages/core/src/ghostlink.ts"],
  ["Chat has been burned", "packages/browser/src/platform/useChat.ts"],
  ["No transport both apps allow is available yet", `${CORE}/ghostlink.ts`],
  ["No permitted transport could connect", `${CORE}/ghostlink.ts`],
  // A transport change that did not land, and the dials it names.
  ["no permitted transport connected", `${CORE}/ghostlink.ts`],
  ["Transport change failed: iroh/1 did not connect in time. Retry or choose another transport.", `${CORE}/ghostlink.ts`, ". Retry or choose another transport."],
  ["iroh/1 did not connect in time", `${CORE}/ghostlink.ts`, " did not connect in time"],
  ["Transport change timed out. Your previous connection is kept when available; retry or choose another transport.", `${CORE}/transportSwitch.ts`],
  ["Transport change cancelled", `${CORE}/ghostlink.ts`],
  ["Transport preferences do not overlap. Enable fallback or choose the same supported transport on both sides.", `${CORE}/transportSwitch.ts`],
  ["Peer native address unavailable; reconnect WebRTC once to exchange endpoints", `${CORE}/ghostlink.ts`],
  ["Peer native address unavailable; the contact's app has not given it yet", `${CORE}/ghostlink.ts`],
  ["Native connection limit reached", "native/transports/hyperdht/endpoint.mjs"],
  ["HyperDHT handshake timed out", "native/transports/hyperdht/endpoint.mjs"],
  ["Noise handshake failed", "native/transports/hyperdht/endpoint.mjs"],
  // The same dial failed on this side, by its own runtime.
  ["Iroh connection timed out", "native/transports/src/iroh_transport.rs"],
  ["Iroh connection timed out", "native/transports/iroh-web/src/lib.rs"],
  ["HyperDHT connection timed out", "apps/desktop/src/hyperdht.rs"],
  ["Native stream timed out", "apps/desktop/src/paired_transport.rs"],
  ["Native stream timed out", "native/transports/iroh-web/src/lib.rs"],
  ["Native channel closed", "native/transports/hyperdht/endpoint.mjs"],
  ["Native channel did not reach the application", "apps/ui/src/desktop/nativeTransports.ts"],
  // A dial past the contact's two channels: its endpoint destroys the stream, and the dialer's stream reads a reset
  // (libudx's own words, measured on a local HyperDHT testnet).
  ["connection reset by peer", "native/transports/hyperdht/endpoint.mjs", "if (stopped || channels.size >= 2) { socket.destroy();"],
  ["PEER_NOT_FOUND: Peer not found", "node_modules/hyperdht/lib/errors.js", "static PEER_NOT_FOUND(msg = 'Peer not found')"],
  // A contact's app that is seen but does not answer (frozen, asleep): its record is fresh, the dial fails after ~4 s.
  ["PEER_CONNECTION_FAILED: Could not connect to peer", "node_modules/hyperdht/lib/errors.js", "static PEER_CONNECTION_FAILED(msg = 'Could not connect to peer')"],
  ["HOLEPUNCH_ABORTED: Holepunch aborted", "node_modules/hyperdht/lib/errors.js", "static HOLEPUNCH_ABORTED(msg = 'Holepunch aborted')"],
  // The Desktop's own HyperDHT runtime (apps/desktop/src/hyperdht.rs): a dial while one runs, the runtime gone.
  ["A native connection attempt is already running", "apps/desktop/src/hyperdht.rs"],
  ["HyperDHT endpoint closed", "apps/desktop/src/hyperdht.rs"],
  ["HyperDHT runtime stopped", "apps/desktop/src/hyperdht.rs"],
  ["Native runtime stopped", "apps/desktop/src/hyperdht.rs"],
  ["HyperDHT failed", "apps/desktop/src/hyperdht.rs"],
  ["It did not connect", `${BROWSER}/engine/node.ts`],
  ["The peer closed this connection. Check that both transport preferences allow a common transport, then reconnect.", `${CORE}/ghostlink.ts`],
  ["Your contact needs an updated app to negotiate a transport change.", `${CORE}/ghostlink.ts`],
  ["Calls need a live connection", `${CORE}/ghostlink.ts`],
  ["Screen sharing is blocked. Allow screen recording for this app in your system's privacy settings.", "packages/react/src/useWebRTC.ts"],
  ["There is no screen to share", "packages/react/src/useWebRTC.ts"],
  ["Screen sharing is not available here", "packages/react/src/useWebRTC.ts"],
  ["Could not share the screen. Try again.", "packages/react/src/useWebRTC.ts"],
  ["Your contact's app cannot show a screen in this call", "packages/react/src/useWebRTC.ts"],
  ["Screen sharing is not available on Linux yet", "apps/ui/src/desktop/nativeCalls.ts"],
  ["Your contact's app cannot take calls", `${CORE}/ghostlink.ts`],
  ["Your contact needs an updated Ghostly for calls", `${CORE}/ghostlink.ts`],
  ["Calls are not available in this app", `${CORE}/ghostlink.ts`],
  ["All native connection slots are in use. This chat takes one once a chat live over one has been quiet for 2 minutes. Disconnect a native connection in another chat to free one now.", "packages/browser/src/engine/node.ts"],
  ["Could not reach the HyperDHT relay", `${BROWSER}/platform/hyperdhtRelay.ts`],
  ["The HyperDHT relay did not answer", `${BROWSER}/platform/hyperdhtRelay.ts`],
  ["The HyperDHT relay closed the connection", `${BROWSER}/platform/hyperdhtRelay.ts`],
  ["The HyperDHT relay did not let this chat listen", `${BROWSER}/platform/hyperdhtRelay.ts`],
  ["Iroh endpoint is stopped", `${BROWSER}/platform/irohWeb.ts`],
  ["Iroh relay unreachable", "native/transports/iroh-web/src/lib.rs"],
  // A contact's Iroh relay this device does not dial: not a public https one, or not one of the person's own with Hide my IP on.
  ["The contact's Iroh relay is not one this device dials", `${BROWSER}/platform/irohWeb.ts`],
  ["The contact's Iroh relay is not one this device dials", "apps/desktop/src/paired_transport.rs"],
  ["The contact is not on one of this profile's Iroh relays", `${BROWSER}/platform/irohWeb.ts`],
  ["The connection changed. Compare the current code again.", "packages/core/src/pairedSession.ts"],
  ["Compare the current code again.", "packages/core/src/ghostlink.ts"],
  ["The connection closed. Compare again after reconnecting.", "packages/core/src/pairedSession.ts"],
  ["The Ghostly peer is unavailable. Reopen the extension to retry.", "apps/extension/src/host.ts"],
  ["Switching profiles…", "apps/extension/src/host.ts"],
  ["Ghostly needs the sign-in permission for this.", "apps/extension/src/oidc.ts"],
  ["Sign-in was cancelled.", "apps/extension/src/atproto.ts"],
  ["Sign-in cancelled", "apps/extension/src/oidc.ts"],
  ["Could not open a wallet", "apps/extension/src/host.ts"],
  ["Could not open the service", "apps/extension/src/host.ts"],
  ["Could not open a tab", "apps/extension/src/background.ts"],
  ["Not a payment link", "apps/extension/src/background.ts"],
  ["Sign-in timed out. Try again.", `${BROWSER}/proofs/oidc/popup.ts`],
  ["Sign-in timed out. Try again.", "apps/desktop/src/oidc.rs"],
  // The app's opener and its Android host.
  ["No app on this phone opens this link", `${ANDROID_APP}/GhostlyHostPlugin.kt`],
  ["The file could not be saved there", `${ANDROID_APP}/GhostlyHostPlugin.kt`],
  ["Not a web link", "apps/desktop/src/commands.rs"],
  ["Not a Ghostly project link", "apps/desktop/src/commands.rs"],
  ["Unreadable file path", "apps/desktop/src/android.rs"],
  ["The Android host is not ready", "apps/desktop/src/android.rs"],
  ["Not from Android's main thread", "apps/desktop/src/android.rs"],
  ["Ghostly is starting…", `${BROWSER}/platform/engine.ts`],
  ["Lost the Ghostly peer", `${BROWSER}/platform/engine.ts`],
  ["This device has no room left to save this", `${BROWSER}/shared/idb.ts`],
  ["Ghostly is still starting. Try again in a moment.", `${BROWSER}/platform/services.ts`],
  ["Ghostly needs your permission to reach that local address", `${BROWSER}/platform/services.ts`],
  // The Share form's address checks (core http.ts parseLocalTarget) and its name check (engine node.ts addService).
  ["Not a valid URL", `${CORE}/http.ts`],
  ["Only http and https targets are supported", `${CORE}/http.ts`],
  ["Credentials in the target URL are not supported", `${CORE}/http.ts`],
  ["Only services on this machine can be shared (localhost, 127.0.0.1 or [::1])", `${CORE}/http.ts`],
  ["The target cannot contain a query or fragment", `${CORE}/http.ts`],
  ["Port 0 is not a port a web app can listen on", `${CORE}/http.ts`],
  ["Give the service a name", `${BROWSER}/engine/node.ts`],
  ["Pick a Lightning card first", `${BROWSER}/platform/services.ts`],
  ["This client cannot install updates", `${BROWSER}/platform/updates.ts`],
  ["Connect to an updated peer to send files", `${BROWSER}/platform/services.ts`],
  ["Connect to an updated peer first", `${BROWSER}/platform/services.ts`],
  ["That recording cannot be sent as a voice message", `${BROWSER}/platform/services.ts`],
  ["This picture cannot be sent: Ghostly could not remove the details saved in it, like where it was taken", `${CORE}/pictureMetadata.ts`],
  ["This video cannot be sent: Ghostly could not remove the details saved in it, like where it was recorded", `${CORE}/videoMetadata.ts`],
  ["This audio cannot be sent: Ghostly could not remove the details saved in it, like where it was recorded", `${CORE}/audioMetadata.ts`],
  ["This file cannot be retried", `${BROWSER}/platform/services.ts`],
  ["This file is no longer here", `${BROWSER}/platform/services.ts`],
  // A large file whose copy into this device failed before it was sent: nothing stored, the file is picked again.
  ["Could not read the file: The file changed while it was being copied", `${BROWSER}/platform/services.ts`, "`Could not read the file: ${reason}`"],
  ["Not enough space on this device to send it", `${BROWSER}/platform/services.ts`],
  ["Held messages need S3 storage (Profile → Backups) and a contact that allows them.", `${BROWSER}/engine/node.ts`],
  ["Not enough space on your contact's device for this file (2.0 MB free).", `${BROWSER}/platform/services.ts`, "Not enough space on your contact's device for this file ("],
  ["That file is too large for your contact's app (max 64 MB). Larger files need an updated Ghostly on their side.", `${BROWSER}/platform/services.ts`, ". Larger files need an updated Ghostly on their side."],
  ["Not enough space on your contact's device (1.1 MB free)", `${CORE}/chatFiles.ts`, "Not enough space on your contact's device ("],
  ["Not enough space on your contact's device", `${CORE}/chatFiles.ts`],
  ["Your contact has too many files waiting. Try again later.", `${CORE}/chatFiles.ts`],
  ["The file arrived damaged and was deleted. Send it again.", `${CORE}/chatFiles.ts`],
  ["Not accepted in time", `${CORE}/chatFiles.ts`],
  ["The file arrived damaged and was deleted. Ask for it again.", `${CORE}/chatFiles.ts`],
  ["The offer expired", `${CORE}/chatFiles.ts`],
  ["Not delivered in time", `${CORE}/chatFiles.ts`],
  ["Your contact asked for the same part of this file too many times", `${CORE}/chatFiles.ts`],
  ["Could not store the file: This device has no space left for the file", `${CORE}/chatFiles.ts`, "Could not store the file: "],
  // The same where file bytes live in IndexedDB (shared/idb.ts `committed`): a line received files kept before it was named.
  ["Could not store the file: This device has no room left to save this", `${BROWSER}/shared/idb.ts`, "This device has no room left to save this"],
  ["Could not store the file: The stored copy is gone", `${CORE}/chatFiles.ts`, "Could not store the file: "],
  ["Your contact could not take this file", `${CORE}/chatFiles.ts`],
  ["Cancelled by the sender", `${CORE}/chatFiles.ts`],
  // A 1:1 file declined or cancelled, by the contact (chatFiles.ts `refusalText`) or here: the bubble's ⓘ says who.
  ["Declined by your contact", `${CORE}/chatFiles.ts`],
  ["Cancelled by your contact", `${CORE}/chatFiles.ts`],
  ["You declined it", `${CORE}/chatFiles.ts`],
  ["You cancelled it", `${CORE}/chatFiles.ts`],
  // A file said on the DHT floor that ended here before it came (engine/fileDesk.ts `floorRefusal`, `sweep`).
  ["No room on this device for this file", `${BROWSER}/engine/fileDesk.ts`],
  ["Too many files are waiting here", `${BROWSER}/engine/fileDesk.ts`],
  ["It was refused here", `${BROWSER}/engine/fileDesk.ts`],
  ["It did not come within a week", `${BROWSER}/engine/fileDesk.ts`],
  ["That file is too large (max 64 MB).", `${BROWSER}/platform/services.ts`, "That file is too large (max "],
  // A file forwarded that is still arriving here, or whose bytes are gone (a copy of mine that failed, "Not sent").
  ["The file has not arrived yet", `${BROWSER}/engine/forwards.ts`],
  ["The file is not on this device any more", `${BROWSER}/engine/forwards.ts`],
  ["The file is shorter than it says", `${BROWSER}/engine/forwards.ts`],
  ["The file is shorter than it says", "apps/ui/src/lib/backupFile.ts"],
  // A forward whose message was deleted while its file was copied (engine/forwards.ts), as one deleted before it.
  ["That message is not in this chat", `${BROWSER}/engine/forwards.ts`],
  ["That is not a valid mint URL", CODES],
  ["Mints must use https", CODES],
  ["Enter an amount in sats", `${BROWSER}/engine/wallet.ts`],
  ["Amounts above 1,000,000 sats are not supported", `${BROWSER}/engine/wallet.ts`, " sats are not supported"],
  ["mint.example did not answer", `${BROWSER}/engine/wallet.ts`, " did not answer"],
  ["Could not reach mint.example. Check the address: it should be a Cashu mint.", CODES, ". Check the address: it should be a Cashu mint."],
  ["No mint configured", `${BROWSER}/engine/wallet.ts`],
  ["No mint could create an invoice: mint.example did not answer", `${BROWSER}/engine/wallet.ts`, "No mint could create an invoice: "],
  ["This wallet has no test mint to ask for test coins", `${BROWSER}/engine/wallet.ts`],
  ["testnut.example has not paid its test coins yet: they show up here once it does", `${BROWSER}/engine/wallet.ts`, " has not paid its test coins yet: they show up here once it does"],
  ["mint.example has not answered yet. The payment was not made. The sats set aside for it return to your wallet a few minutes after the mint answers.", `${BROWSER}/engine/wallet.ts`, " has not answered yet. The payment was not made. The sats set aside for it return to your wallet a few minutes after the mint answers."],
  ["mint.example:3338 has not answered yet. The ecash is added to your wallet as soon as it does.", `${BROWSER}/engine/wallet.ts`, " has not answered yet. The ecash is added to your wallet as soon as it does."],
  ["Select a configured mint", `${BROWSER}/engine/wallet.ts`],
  ["That is not a valid ecash token", `${BROWSER}/engine/wallet.ts`],
  // Redeem of a token whose keyset its mint does not have (a crafted token, or one of a keyset the mint dropped): the library's words.
  ["Keyset '009a1f293253e41e' is not a keyset of this mint", "node_modules/@cashu/cashu-ts/lib/cashu-ts.es.js", "' is not a keyset of this mint"],
  ["Ecash from mint.example is not accepted", `${BROWSER}/engine/wallet.ts`, " is not accepted"],
  ["Add a mint in Settings first", `${BROWSER}/engine/wallet.ts`],
  ["Not enough sats in your wallet", CODES],
  ["Not enough sats in your wallet: 690 sats leave room for the fee", CODES, ": {amount} sats leave room for the fee"],
  ["None of your mints can pay an invoice with no amount", CODES],
  ["The Lightning payment did not go through. The sats are back in your wallet.", `${BROWSER}/engine/wallet.ts`, "The sats are back in your wallet."],
  ["The Lightning payment did not go through. The sats are back in your wallet, less 2 sats the mint kept as its fee.", `${BROWSER}/engine/wallet.ts`, "The sats are back in your wallet, less "],
  // Never alone: the start of the two above, said on its own before what came back.
  ["The Lightning payment did not go through.", `${BROWSER}/engine/wallet.ts`, "The Lightning payment did not go through. ${"],
  ["The Lightning payment did not go through", `${BROWSER}/engine/payments.ts`, "error: \"The Lightning payment did not go through\" "],
  ["This invoice is already being paid", `${BROWSER}/engine/wallet.ts`],
  ["A Lightning payment from this wallet is still in flight: wait for it to settle, then remove the wallet.", `${BROWSER}/engine/wallet.ts`],
  ["Cashu is off in this chat", `${BROWSER}/engine/payments.ts`],
  ["Both peers need USDT support on a connected data link", `${BROWSER}/engine/payments.ts`],
  ["Both peers need on-chain Bitcoin on a connected data link", `${BROWSER}/engine/payments.ts`],
  ["Join a federation first (Wallet → New → Testnet Fedimint)", `${BROWSER}/engine/payments.ts`, "Join a federation first (Wallet → New → "],
  ["You have no Mainnet Cashu wallet: create one in Wallet → New", `${BROWSER}/engine/payments.ts`, " wallet: create one in Wallet → New"],
  ["This is a Testnet payment, and you have no Testnet Ark wallet: create one in Wallet → New", `${BROWSER}/engine/node.ts`, " payment, and you have no "],
  ["Your contact has no Testnet on-chain Bitcoin wallet", `${BROWSER}/engine/payments.ts`, "Your contact has no "],
  ["Mainnet Lightning is off in this chat", `${BROWSER}/engine/payments.ts`, " is off in this chat"],
  ["Lightning is not allowed by both of you here", `${BROWSER}/engine/payments.ts`, " is not allowed by both of you here"],
  ["Your contact allowed neither Cashu nor Lightning in this chat", `${BROWSER}/engine/payments.ts`],
  ["Your contact took no Cashu or Lightning last time. Try again once the chat is live", `${BROWSER}/engine/payments.ts`],
  ["Your contact is offline. Nothing was sent: pay once the chat is live.", CODES],
  ["Cashu and Lightning are off in this chat", `${BROWSER}/engine/payments.ts`],
  ["A request to the group is paid in Cashu or over Lightning", `${BROWSER}/engine/payments.ts`],
  ["Unknown payment request", `${BROWSER}/engine/payments.ts`],
  ["Review and explicitly approve this payment before sending", `${BROWSER}/engine/payments.ts`],
  ["This request is no longer open", `${BROWSER}/engine/payments.ts`],
  ["A Lightning payment for this request is still pending", `${BROWSER}/engine/payments.ts`],
  ["You already paid this request", `${BROWSER}/engine/payments.ts`],
  ["Already paid by another member of the group", `${BROWSER}/engine/payments.ts`],
  ["Another member of the group is paying it", `${BROWSER}/engine/payments.ts`],
  ["The payment was refused", `${BROWSER}/engine/payments.ts`],
  // A refused send's review once its ecash came back (refusedLine): what came back, less what the mint kept.
  ["Refused: Already paid by another member of the group. 98 sats came back; the mint kept 2 as its fee.", `${BROWSER}/engine/payments.ts`, " came back; the mint kept ${back.fee} as its fee."],
  ["Refused: Already paid by another member of the group. All 100 sats came back.", `${BROWSER}/engine/payments.ts`, "All ${satsWord(back.amount)} came back."],
  ["Refused: unknown mint. The sats came back.", `${BROWSER}/engine/payments.ts`, "The sats came back."],
  ["This request cannot be paid over Lightning in this chat", `${BROWSER}/engine/payments.ts`],
  ["No way of paying this request is allowed in this chat", `${BROWSER}/engine/payments.ts`],
  ["The invoice does not match the requested amount", `${BROWSER}/engine/payments.ts`],
  ["The Lightning fee (21 sats) is too high", CODES, "The Lightning fee ("],
  ["Nothing to take back", `${BROWSER}/engine/payments.ts`],
  ["The federation has not answered yet: try again in a moment", `${BROWSER}/engine/payments.ts`],
  ["Nothing to reclaim", `${BROWSER}/engine/payments.ts`],
  ["Your contact does not accept Ark in this chat", `${BROWSER}/engine/payments.ts`, "Your contact does not accept "],
  ["This request cannot be paid from another wallet", `${BROWSER}/engine/payments.ts`],
  ["You are offline", `${BROWSER}/engine/payments.ts`],
  // What a payee's app sends back for a payment it did not take, shown on the payer's bubble after its state.
  ["Too many payments at once: send it again in a minute", `${BROWSER}/engine/payments.ts`],
  ["This ecash does not pay the request: the amount or the mint differs", `${BROWSER}/engine/payments.ts`],
  ["This transaction already paid another request", `${BROWSER}/engine/payments.ts`],
  ["Too many open USDT requests of this amount: wait for one to be paid", `${BROWSER}/engine/payments.ts`],
  ["The mint quoted another amount than this invoice's. Nothing was paid.", `${BROWSER}/engine/wallet.ts`],
  ["That is not an invoice this wallet can pay", `${BROWSER}/engine/wallet.ts`],
  ["That is not an invoice this wallet can pay", `${BROWSER}/engine/paymentAdapters/providers/webln.ts`],
  // A group's pay to one member, refused when the member list was stale.
  ["Payments are turned off in this group.", `${BROWSER}/engine/communityPay.ts`],
  ["They are no longer in this group", `${BROWSER}/engine/communityPay.ts`],
  ["They take no way of paying this device allows.", `${BROWSER}/engine/communityPay.ts`],
  ["This is a Mainnet payment (real money): a Testnet wallet never pays it. Use a Mainnet wallet.", `${BROWSER}/engine/paymentAdapters/walletInstances.ts`, "payment (${"],
  ["This is a Testnet payment (test coins): a Mainnet wallet never pays it. Use a Testnet wallet.", `${BROWSER}/engine/paymentAdapters/walletInstances.ts`, "wallet never pays it. Use a "],
  ["This pays with real money: confirm it with Send real money first. Nothing was sent.", CODES],
  ["Could not create the Spark wallet: the network is down. Nothing was saved; try again.", `${BROWSER}/engine/paymentAdapters/walletInstances.ts`, ". Nothing was saved; try again."],
  ["You were removed from this group", `${CORE}/groupSession.ts`],
  ["A group's name is 1 to 64 characters on one line", `${BROWSER}/engine/node.ts`, "A group's name is 1 to "],
  ["A group's name is 1 to 64 characters", `${CORE}/groupMeta.ts`, "A group's name is 1 to "],
  ["This picture cannot be used", `${CORE}/groupMeta.ts`],
  ["This hub setting cannot be used", `${CORE}/groupMeta.ts`],
  ["You left this group", `${CORE}/groupSession.ts`],
  ["Member 3r69cgd5 holds a different membership history for epoch 4. Membership changes are halted; the admin must re-form the group.", `${CORE}/groupSession.ts`, " holds a different membership history for epoch "],
  ["Member 3r69cgd5 holds a different membership history for epoch 4. Membership changes are halted; the admin must re-form the group.", `${CORE}/groupSession.ts`, ". Membership changes are halted; the admin must re-form the group."],
  ["The admin signed two different changes after epoch 7. Membership changes are halted; the admin must re-form the group.", `${CORE}/groupCommunity.ts`, "The admin signed two different changes after epoch "],
  ["The admin signed changes on two branches after epoch 7. Membership changes are halted; the admin must re-form the group.", `${CORE}/groupCommunity.ts`, "The admin signed changes on two branches after epoch "],
  ["Two members let people in at the same moment and yours did not count. Asking to be let in again…", `${CORE}/groupCommunity.ts`],
  ["You are no longer in this group", `${CORE}/groupSession.ts`],
  ["You are not in this group yet", `${BROWSER}/engine/groups.ts`],
  ["You are not in this group", `${CORE}/groupCommunity.ts`],
  ["Nothing to send", `${CORE}/groupSession.ts`],
  ["Message exceeds 16 KiB", `${CORE}/groupSession.ts`],
  ["This epoch's key has not arrived yet. Wait for a member to catch you up.", `${CORE}/groupSession.ts`],
  ["Only your own messages can be edited", `${CORE}/groupSession.ts`],
  ["This message was edited too many times", `${CORE}/groupSession.ts`],
  ["This message is too old to edit: its epoch's key is gone", `${CORE}/groupSession.ts`],
  ["An edit cannot be empty", `${CORE}/groupSession.ts`],
  ["Too long to edit in this group", `${CORE}/groupCommunity.ts`],
  ["Only the admin can invite", `${BROWSER}/engine/groups.ts`],
  ["Managing this group is off on this device. Turn on Manage groups from this device first.", `${CORE}/groupCommits.ts`],
  ["This contact is already a member", `${BROWSER}/engine/groups.ts`],
  ["A group holds 32 members at most", `${BROWSER}/engine/groups.ts`, " members at most"],
  ["This contact is not connected right now. Invite them when they are online.", `${BROWSER}/engine/groups.ts`],
  ["Their app does not take part in groups: they need an updated Ghostly first.", `${BROWSER}/engine/groups.ts`],
  ["The contact who invited you is not connected. Try again when they are.", `${BROWSER}/engine/groups.ts`],
  ["You are the admin and nobody else in the group is online to take over. Try again when a member is, or make someone the admin first.", `${BROWSER}/engine/groups.ts`],
  ["Nobody in the group is connected right now to take your leave. Try again in a moment.", `${BROWSER}/engine/community.ts`],
  ["Only the admin can share a link to the group", `${BROWSER}/engine/groups.ts`],
  ["This is not a link to a group", `${BROWSER}/engine/groups.ts`],
  ["There are no digits to confirm", `${BROWSER}/devices/enroll.ts`],
  ["Only an enrollment that did not finish is removed here", `${BROWSER}/devices/links.ts`],
  ["This group is joined with its current link", `${BROWSER}/engine/groups.ts`],
  ["You have an invitation to this group. Answer it first.", `${BROWSER}/engine/groups.ts`],
  ["You are out of this group and its history is still here. Delete it from this device to join with a link.", `${BROWSER}/engine/groups.ts`],
  ["This link names a private group of yours, not a community", `${BROWSER}/engine/groups.ts`],
  ["Go online to join a group", `${BROWSER}/engine/node.ts`],
  ["Only the admin can change the members of this group", `${CORE}/groupSession.ts`],
  ["Only the admin can renew the group's secret", `${CORE}/groupSession.ts`],
  ["Only the admin can hand the admin role over", `${CORE}/groupSession.ts`],
  ["Only the admin can do that", `${CORE}/groupCommunity.ts`],
  ["Make someone else the admin before leaving", `${CORE}/groupSession.ts`],
  ["This member has left the group. Make someone else the admin.", `${CORE}/groupCommunity.ts`],
  ["Not a member", `${CORE}/groupCommunity.ts`, "throw new Error(\"Not a member\")"],
  ["Not a member", `${CORE}/groupSession.ts`, "throw new Error(\"Not a member\")"],
  ["Only the admin can change the group's picture", `${CORE}/groupSession.ts`],
  ["Only the admin can rename the group", `${CORE}/groupSession.ts`],
  ["Only the admin can choose the group's hubs", `${CORE}/groupSession.ts`],
  ["Only the admin can replace or turn off the group's link", `${BROWSER}/engine/community.ts`],
  ["This group has reached its membership history limit. Create a new group.", `${CORE}/groupSession.ts`],
  ["This group runs through hubs, which their app does not take part in: they need an updated Ghostly first.", `${BROWSER}/engine/groups.ts`],
  ["Their app takes groups of 8 at most: they need an updated Ghostly first.", `${BROWSER}/engine/groups.ts`, " at most: they need an updated Ghostly first."],
  ["A group grows past 8 only when everyone is on an updated Ghostly. Not seen updated yet: Ana, Member 3r69cgd5 and 2 more.", `${BROWSER}/engine/groups.ts`, " only when everyone is on an updated Ghostly. Not seen updated yet: "],
  ["Share the group's link with them: anyone who opens it joins", `${BROWSER}/engine/groups.ts`],
  ["At most 4 members can be pinned as hubs", `${CORE}/groupSession.ts`, " members can be pinned as hubs"],
  ["A community group chooses its hubs by itself", `${BROWSER}/engine/groups.ts`],
  ["You sent many files to this group just now. Wait a minute.", `${BROWSER}/engine/groupFiles.ts`, "You sent many files to this group just now. Wait ${minutes > 1 ? `${minutes} minutes` : \"a minute\"}."],
  ["You sent many files to this group just now. Wait 7 minutes.", `${BROWSER}/engine/groupFiles.ts`, "You sent many files to this group just now. Wait ${minutes > 1 ? `${minutes} minutes` : \"a minute\"}."],
  ["Not enough space on this device for this file", `${BROWSER}/engine/groupFiles.ts`],
  ["Every copy of this file arrived damaged and was deleted. Ask for it again later.", `${BROWSER}/engine/groupFiles.ts`],
  ["An empty file cannot go to a group", `${BROWSER}/platform/services.ts`],
  ["This app takes no group files", `${BROWSER}/engine/groups.ts`],
  ["A group takes files of up to 100.0 MB", `${BROWSER}/engine/node.ts`, "A group takes files of up to "],
  ["No route to the recipient within the fee limit", `${BROWSER}/engine/paymentAdapters/providers/lnd.ts`],
  ["Not enough outbound liquidity in the node's channels", `${BROWSER}/engine/paymentAdapters/providers/lnd.ts`],
  ["The node gave up finding a route", `${BROWSER}/engine/paymentAdapters/providers/lnd.ts`],
  ["The recipient refused the payment (unknown or already paid invoice)", `${BROWSER}/engine/paymentAdapters/providers/lnd.ts`],
  ["The payment failed", `${BROWSER}/engine/paymentAdapters/providers/lnd.ts`],
  ["The payment failed: no route found", `${BROWSER}/engine/paymentAdapters/providers/nwc.ts`, "The payment failed: "],
  ["The payment was canceled", `${BROWSER}/engine/paymentAdapters/providers/lnd.ts`],
  ["The node did not answer in time", `${BROWSER}/engine/paymentAdapters/providers/lnd.ts`],
  ["The payment did not go through", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`],
  ["No answer from the source. It is being checked; nothing is paid again.", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`],
  ["No answer from the source, and it cannot be asked: check this payment in the wallet itself. It is never paid again.", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`],
  ["Interrupted. It is being checked; nothing is paid again.", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`],
  ["This invoice is already paid", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`],
  ["That invoice is for regtest, a test network: pay it from a Testnet wallet", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`, ", a test network: pay it from a Testnet wallet"],
  ["This is a Bitcoin invoice (real money): test sats pay one only through the public test mint. Nothing was sent.", `${BROWSER}/shared/mints.ts`],
  ["This quote is no longer valid: check the invoice again", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`],
  ["The Lightning source changed: check the invoice again", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`],
  ["That is not a Lightning invoice", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`],
  ["Invoices without an amount are not supported", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`],
  ["The wallet refused the payment: insufficient balance", `${BROWSER}/engine/paymentAdapters/providers/nwc.ts`, "The wallet refused the payment: "],
  ["The payment did not reach the wallet: The relay did not confirm the request", `${BROWSER}/engine/paymentAdapters/providers/nwc.ts`, "The payment did not reach the wallet: "],
  ["The wallet said the payment failed (timeout), and cannot confirm it yet", `${BROWSER}/engine/paymentAdapters/providers/nwc.ts`, "), and cannot confirm it yet"],
  ["Could not reach the wallet's relay", `${BROWSER}/engine/paymentAdapters/providers/nwc.ts`],
  ["The wallet's relay did not answer", `${BROWSER}/engine/paymentAdapters/providers/nwc.ts`],
  ["The wallet's relay closed the connection", `${BROWSER}/engine/paymentAdapters/providers/nwc.ts`],
  ["The browser wallet did not pay: User rejected", `${BROWSER}/engine/paymentAdapters/providers/webln.ts`, "The browser wallet did not pay: "],
  ["Not enough in the browser wallet (1200 sats)", `${BROWSER}/engine/paymentAdapters/providers/webln.ts`, "Not enough in the browser wallet ("],
  ["The Lightning fee (1200 sats) is above your limit (1000)", `${BROWSER}/engine/paymentAdapters/providers/breez.ts`, "sats) is above your limit ("],
  ["Not enough sats in the Breez wallet (1000; 1200 needed)", `${BROWSER}/engine/paymentAdapters/providers/breez.ts`, "Not enough sats in the Breez wallet ("],
  ["This federation has no Lightning gateway online", `${BROWSER}/engine/paymentAdapters/providers/fedimint.ts`],
  ["The gateway's fee (1200 sats) is above your maximum", `${BROWSER}/engine/paymentAdapters/providers/fedimint.ts`, " sats) is above your maximum"],
  ["Not enough in this federation (1,000 sats; 1,200 needed)", `${BROWSER}/engine/paymentAdapters/providers/fedimint.ts`, "Not enough in this federation ("],
  ["Insufficient Bark balance", `${BROWSER}/engine/paymentAdapters/bark.ts`, "Insufficient Bark balance"],
  ["Could not prepare this Ark payment. Check funds, address and provider.", `${BROWSER}/engine/paymentAdapters/arkade.ts`],
  ["The Spark fee exceeds your limit", `${BROWSER}/engine/paymentAdapters/spark.ts`, "The Spark fee exceeds your limit"],
  ["Bark payment outcome unknown", `${BROWSER}/engine/paymentAdapters/bark.ts`, "Bark payment outcome unknown"],
  ["The Bark fee changed. Create a new review", `${BROWSER}/engine/paymentAdapters/bark.ts`, "The Bark fee changed. Create a new review"],
  ["Spark balance changed. Create a new review", `${BROWSER}/engine/paymentAdapters/spark.ts`, "Spark balance changed. Create a new review"],
  ["The Bark server did not take this payment. Nothing was sent.", `${BROWSER}/engine/paymentAdapters/bark.ts`],
  ["Spark did not take this payment. Nothing was sent.", `${BROWSER}/engine/paymentAdapters/spark.ts`],
  ["The Spark invoice has expired", `${BROWSER}/engine/paymentAdapters/spark.ts`],
  ["USDT RPC rejected the operation", `${BROWSER}/engine/paymentAdapters/usdt.ts`],
  ["Token or gas balance changed. Create a new review", `${BROWSER}/engine/paymentAdapters/usdt.ts`],
  ["Account nonce changed. Create a new review", `${BROWSER}/engine/paymentAdapters/usdt.ts`],
  ["No signed transaction was submitted. Create a new review.", `${BROWSER}/engine/paymentAdapters/usdt.ts`],
  ["Transaction reverted. Tokens were not sent; gas was spent.", `${BROWSER}/engine/paymentAdapters/usdt.ts`],
  ["Not enough confirmed sats: 1000 available, 1200 needed with the fee", `${BROWSER}/engine/paymentAdapters/providers/bdk.ts`, "Not enough confirmed sats: "],
  ["The fee (1200 sats) is above your limit of 1000", `${BROWSER}/engine/paymentAdapters/providers/bdk.ts`, " sats) is above your limit of "],
  ["The node refused the transaction: min relay fee not met", `${BROWSER}/engine/paymentAdapters/providers/bdk.ts`, "The node refused the transaction: "],
  ["Your node cannot estimate a fee yet. Nothing was sent.", `${BROWSER}/engine/paymentAdapters/providers/bitcoind.ts`],
  ["Your node did not send it: insufficient fee", `${BROWSER}/engine/paymentAdapters/providers/bitcoind.ts`, "Your node did not send it: "],
  ["Another transaction spent these coins: this payment can never confirm", `${BROWSER}/engine/paymentAdapters/providers/bitcoinService.ts`],
  ["The Bitcoin source that prepared this payment is not connected. Nothing was sent.", `${BROWSER}/engine/paymentAdapters/providers/bitcoinService.ts`],
  ["This payment was never approved: nothing was sent", `${BROWSER}/engine/paymentAdapters/providers/bitcoinService.ts`],
  ["Not enough in this federation: 1,000 sats", `${BROWSER}/engine/paymentAdapters/fedimint.ts`, "Not enough in this federation: "],
  ["Not enough in this federation any more", `${BROWSER}/engine/paymentAdapters/fedimint.ts`],
  ["Taken back: the sats are in your wallet again", `${BROWSER}/engine/paymentAdapters/fedimint.ts`],
  ["Nothing was spent", `${BROWSER}/engine/paymentAdapters/fedimint.ts`],
  ["Interrupted before it reached your contact: the sats came back", `${BROWSER}/engine/paymentAdapters/fedimint.ts`],
  ["Canceled before it was funded", `${BROWSER}/engine/paymentAdapters/fedimintSdk.ts`],
  ["The payment never reached the mint: nothing was sent, and the sats are back in your wallet. You can pay again.", `${BROWSER}/engine/paymentAdapters/cashu.ts`],
  ["Only whole amounts in sats are supported", `${BROWSER}/engine/payments.ts`],
  ["Unknown payment", `${BROWSER}/engine/payments.ts`],
  ["The mint did not confirm the ecash", `${BROWSER}/engine/payments.ts`],
  ["your contact closed it", `${BROWSER}/engine/payments.ts`],
  ["your contact removed the wallet it was paid to", `${BROWSER}/engine/payments.ts`],
  ["Fedimint is off in this chat", `${BROWSER}/engine/payments.ts`],
  ["This app has no Fedimint wallet", `${BROWSER}/engine/payments.ts`],
  ["Unsupported amount", `${BROWSER}/engine/payments.ts`],
  ["These notes are from a federation I have not joined", `${BROWSER}/engine/payments.ts`],
  ["These notes are worth less than a sat", `${BROWSER}/engine/payments.ts`],
  ["These notes were already redeemed", `${BROWSER}/engine/payments.ts`],
  ["The server took too long to answer", `${CORE}/lnurl.ts`],
  ["No way to reach the network here", `${CORE}/lnurl.ts`],
  ["shop.example refused: amount too small", `${CORE}/lnurl.ts`, " refused: "],
  ["shop.example answered HTTP 502", `${CORE}/lnurl.ts`, " answered HTTP "],
  ["shop.example did not answer with JSON", `${CORE}/lnurl.ts`, " did not answer with JSON"],
  ["shop.example did not answer with JSON (HTTP 502)", `${CORE}/lnurl.ts`, " (HTTP ${"],
  ["shop.example did not answer with a pay request", `${CORE}/lnurl.ts`, " did not answer with a pay request"],
  ["shop.example did not answer with an invoice", `${CORE}/lnurl.ts`, " did not answer with an invoice"],
  ["The invoice the service answered with has already expired", `${CORE}/lnurl.ts`],
  // An invoice the Lightning address answered with for another amount than the one chosen, or for any amount.
  ["The invoice asks for 1,234,567 sats, not the 21,000 sats you chose", `${CORE}/lnurl.ts`, "The invoice asks for "],
  ["The invoice asks for any amount, not the 21 sats you chose", `${CORE}/lnurl.ts`, "\"any amount\""],
  ["Give the profile a name", "apps/ui/src/lib/profiles.ts"],
  ["That profile already exists", "apps/ui/src/lib/profiles.ts"],
  ["The first profile cannot be removed", "apps/ui/src/lib/profiles.ts"],
  ["The first profile cannot be deleted", "apps/ui/src/lib/profileData.ts"],
  ["Switch to another profile first", "apps/ui/src/lib/profiles.ts"],
  ["Unknown profile", "apps/ui/src/lib/profiles.ts"],
  ["This profile is open in another window. Close it, then try again.", "apps/ui/src/lib/profileData.ts"],
  ["Could not delete this profile's data", "apps/ui/src/lib/profileData.ts"],
  ["Wrong lock password for that profile", "apps/ui/src/lib/profileData.ts"],
  ["Too many attempts. Try again in 4 s", "apps/ui/src/lib/lockAttempts.ts", "Too many attempts. Try again in "],
  ["This backup does not hold a profile", "apps/ui/src/lib/profileBackup.ts"],
  ["This device has no room left for this backup. Free some space, then try again.", "apps/ui/src/lib/profileBackup.ts"],
  ["Wrong passphrase, or the backup was changed", "packages/browser/src/backup/stream.ts"],
  ["This is not a Ghostly backup", "packages/browser/src/backup/envelope.ts"],
  ["This backup is damaged: it was changed or cut short", "packages/browser/src/backup/stream.ts"],
  ["This backup is too large to restore", "packages/browser/src/backup/stream.ts"],
  ["This backup comes from a newer Ghostly; update to restore it", "packages/browser/src/backup/stream.ts"],
  ["Unsupported backup encryption", "packages/browser/src/backup/stream.ts"],
  ["Use at least 12 characters for the backup passphrase", "packages/browser/src/backup/stream.ts"],
  ["This device has no storage for files", "packages/browser/src/shared/fileBytes.ts"],
  ["Could not read the Ark wallet for the backup: quota exceeded", "apps/ui/src/lib/profileBackup.ts", "Could not read the Ark wallet for the backup: "],
  ["This wallet has no recovery phrase to show", "apps/ui/src/components/wallet/walletPhrase.ts"],
  ["This wallet has no backup file", "apps/ui/src/components/wallet/walletPhrase.ts"],
  ["Choose a picture", "apps/ui/src/lib/avatarImage.ts"],
  ["That picture is too large (max 20 MB)", "apps/ui/src/lib/avatarImage.ts"],
  ["This picture cannot be read here. Try a JPEG or PNG.", "apps/ui/src/lib/avatarImage.ts"],
  ["This picture cannot be read here", "apps/ui/src/lib/avatarImage.ts"],
  ["This picture could not be made small enough", "apps/ui/src/lib/avatarImage.ts"],
  ["That is too large to paste. Send it with + → Document.", "apps/ui/src/lib/pastedFiles.ts"],
  // A paste the app's clipboard commands refused (Desktop).
  ["That picture is too large to paste", "apps/desktop/src/clipboard.rs"],
  ["The clipboard's picture is damaged", "apps/desktop/src/clipboard.rs"],
  ["Clipboard unavailable", "apps/desktop/src/clipboard.rs"],
  ["That paste is gone. Paste it again.", "apps/desktop/src/clipboard.rs"],
  ["That is too large to drop. Send it with + → Document.", "apps/ui/src/lib/pastedFiles.ts"],
  ["That drop is gone. Drop it again.", "apps/ui/src/lib/pastedFiles.ts"],
  ["Could not read the pasted file: Permission denied (os error 13)", "apps/desktop/src/clipboard.rs", "Could not read the pasted file: {e}"],
  ["Could not read the file: The file changed while it was being copied", `${CORE}/chatFiles.ts`, "Could not read the file: "],
  ["This browser cannot wake Ghostly while it is closed.", "apps/ui/src/lib/wakePush.ts"],
  ["Your signer holds a different key than this identity. Nothing was published.", "apps/ui/src/lib/nostr.ts"],
  ["This device cannot decode the recording", "apps/ui/src/lib/voiceMp3.ts"],
  ["That update is no longer available", "apps/ui/src/desktop/updates.ts"],
  ["The video took too long", "apps/ui/src/lib/videoPoster.ts"],
  ["You already have a Testnet Cashu wallet", `${BROWSER}/engine/node.ts`, "You already have a "],
  ["The Testnet Ark wallet did not come up. Nothing was lost: try again.", `${BROWSER}/engine/node.ts`, " wallet did not come up. Nothing was lost: try again."],
  ["It did not answer in time", `${BROWSER}/engine/node.ts`],
  ["No mint answered", `${BROWSER}/engine/node.ts`],
  ["Paste the federation's invite code (fed11…)", `${BROWSER}/engine/node.ts`],
  ["Choose a Lightning source that runs on Testnet", `${BROWSER}/engine/node.ts`, " source that runs on "],
  ["This wallet cannot be made here", `${BROWSER}/engine/node.ts`],
  ["No Lightning source runs on Mainnet here yet", `${BROWSER}/engine/node.ts`, "No Lightning source runs on "],
  ["No on-chain wallet runs on Mainnet here yet", `${BROWSER}/engine/node.ts`, "No on-chain wallet runs on "],
  ["The Bark server is not answering", `${BROWSER}/engine/paymentAdapters/bark.ts`],
  ["Could not join the federation: its guardians did not answer, or the invite code is not valid", `${BROWSER}/engine/paymentAdapters/fedimintSdk.ts`],
  ["That Ark provider runs on bitcoin, not mutinynet", `${BROWSER}/engine/paymentAdapters/arkWallet.ts`, "That Ark provider runs on "],
  ["That Bark server does not run on signet", `${BROWSER}/engine/paymentAdapters/barkWallet.ts`, "That Bark server does not run on "],
  ["bitcoin is a Mainnet network: this is the Testnet Ark wallet", `${BROWSER}/engine/paymentAdapters/arkWallet.ts`, " network: this is the "],
  ["Could not connect to LND: The node did not answer in time", `${BROWSER}/engine/paymentAdapters/providers/sources.ts`, "Could not connect to ${"],
  ["Could not read the balance: The node did not answer in time", `${BROWSER}/engine/paymentAdapters/providers/sources.ts`, "Could not read the balance: "],
  ["cln is not available in this version of Ghostly", `${BROWSER}/engine/paymentAdapters/providers/sources.ts`, " is not available in this version of Ghostly"],
  ["the Esplora server at mempool.space did not answer in 10 s", `${BROWSER}/engine/paymentAdapters/providers/bdk.ts`, " did not answer in ${"],
  ["the Esplora server at mempool.space did not answer (Failed to fetch)", `${BROWSER}/engine/paymentAdapters/providers/bdk.ts`, " did not answer (${"],
  ["nothing answers at localhost:3002: the local Esplora server is not running", `${BROWSER}/engine/paymentAdapters/providers/bdk.ts`, ": the local Esplora server is not running"],
  ["the Esplora server at mempool.space answered 503: it is down or busy", `${BROWSER}/engine/paymentAdapters/providers/bdk.ts`, ": it is down or busy"],
  ["no public signet Esplora server answered (mempool.space): Failed to fetch", `${BROWSER}/engine/paymentAdapters/providers/bdk.ts`, " Esplora server answered (${"],
  ["wrong network: the Esplora server at mempool.space is on bitcoin, not signet", `${BROWSER}/engine/paymentAdapters/providers/bdk.ts`, "wrong network: the Esplora server at "],
  ["Connecting to Ark…", `${BROWSER}/engine/paymentAdapters/arkWallet.ts`, "Connecting to Ark… ${"],
  ["Connecting to Bark… The Bark server is not answering", `${BROWSER}/engine/paymentAdapters/barkWallet.ts`, "Connecting to Bark… ${"],
  ["Could not read the balance, history from the Ark provider. Last values may be stale.", `${BROWSER}/engine/paymentAdapters/arkWallet.ts`, " from the Ark provider. Last values may be stale."],
  ["Could not read the balance from the Bark server. Last values may be stale.", `${BROWSER}/engine/paymentAdapters/barkWallet.ts`, " from the Bark server. Last values may be stale."],
  ["Could not read the address, sync from Spark. Last values may be stale.", `${BROWSER}/engine/paymentAdapters/sparkWallet.ts`, " from Spark. Last values may be stale."],
  ["RPC unavailable. Balance may be stale.", `${BROWSER}/engine/paymentAdapters/usdtWallet.ts`],
  ["Rate limited: the faucet is busy. Try again in a minute.", `${BROWSER}/engine/paymentAdapters/testCoins.ts`],
  ["The faucet did not answer: Failed to fetch", `${BROWSER}/engine/paymentAdapters/testCoins.ts`, "The faucet did not answer: "],
  ["The faucet did not pay: empty", `${BROWSER}/engine/paymentAdapters/testCoins.ts`, "The faucet did not pay: "],
  ["This signature was made by another key (0123ABCD), not the public key given.", `${BROWSER}/proofs/openpgp.ts`, "This signature was made by another key ("],
  ["That signature was made by SHA256:abc, not the key you entered (SHA256:def)", `${BROWSER}/proofs/providers/ssh.ts`, ", not the key you entered ("],
  ["No Ghostly TXT record at _ghostly.example.com (DNS changes can take a few minutes)", `${BROWSER}/proofs/domain.ts`, "No Ghostly TXT record at ${"],
  ["https://example.com/.well-known/ghostly.json was not found", `${BROWSER}/proofs/domain.ts`, " was not found`"],
  ["https://example.com/.well-known/ghostly/ab12.json was not found: it was deleted, or not uploaded yet", `${BROWSER}/proofs/providers/did.ts`, " was not found: it was deleted, or not uploaded yet"],
  ["https://example.com/.well-known/ghostly.json names no Ghostly proof", `${BROWSER}/proofs/domain.ts`, " names no Ghostly proof`"],
  // A domain proof the record, file, resolver or host refused (agents#2541).
  ["The TXT record at _ghostly.example.com is for another proof of this key", `${BROWSER}/proofs/domain.ts`, "`${where} is for another proof of this key`"],
  ["The TXT record at _ghostly.example.com names another Ghostly key: this proof was replaced or removed", `${BROWSER}/proofs/domain.ts`, "`${where} names another Ghostly key: this proof was replaced or removed`"],
  ["https://example.com/.well-known/ghostly.json is for another proof of this key", `${BROWSER}/proofs/domain.ts`, "`${where} is for another proof of this key`"],
  ["https://example.com/.well-known/ghostly.json names another Ghostly key: this proof was replaced or removed", `${BROWSER}/proofs/domain.ts`, "`${where} names another Ghostly key: this proof was replaced or removed`"],
  ["https://example.com/.well-known/ghostly.json is not a valid Ghostly file", `${BROWSER}/proofs/domain.ts`, " is not a valid ${method === 'nip05' ? 'NIP-05' : 'Ghostly'} file`"],
  ["example.com could not be reached. The file must be served at exactly this address, without a redirect, with the header Access-Control-Allow-Origin: *", `${BROWSER}/proofs/domain.ts`, "`${domain} could not be reached. The file must be served at exactly this address, without a redirect, with the header Access-Control-Allow-Origin: *`"],
  ["Quad9 could not be reached", `${BROWSER}/proofs/domain.ts`, "`${resolver.name} could not be reached`"],
  ["Quad9 refused the lookup", `${BROWSER}/proofs/domain.ts`, "`${resolver.name} refused the lookup`"],
  ["example.com has no address", `${BROWSER}/proofs/domain.ts`, "`${domain} has no address`"],
  ["example.com points to a private network address, so it was not contacted", `${BROWSER}/proofs/domain.ts`, "`${domain} points to a private network address, so it was not contacted`"],
  ["GitHub: octo-cat does not list the key that signed (SHA256:abc)", `${BROWSER}/proofs/providers/ssh.ts`, " does not list the key that signed ("],
  ...PROOF_REASONS,
  // What the Add dialog's field refuses (agents#2222).
  ["Enter a domain name, like example.com", `${CORE}/domainProofs.ts`],
  ["Enter only the domain name, without a path or port", `${CORE}/domainProofs.ts`],
  ["That is not a valid domain name", `${CORE}/domainProofs.ts`],
  ["That domain name is too long", `${CORE}/domainProofs.ts`],
  ["Use a full domain name, like example.com", `${CORE}/domainProofs.ts`],
  ["Use a domain name, not an IP address", `${CORE}/domainProofs.ts`],
  ["That name only works on private networks", `${CORE}/domainProofs.ts`],
  ["Enter a Bitcoin address", `${BROWSER}/proofs/providers/bitcoin.ts`],
  ["Ghostly can check proofs for single-key addresses only (bc1q…, bc1p…, 3…, 1…), not multisig or script addresses", `${BROWSER}/proofs/providers/bitcoin.ts`],
  ["Paste the signature your wallet made", `${BROWSER}/proofs/providers/bitcoin.ts`],
  ["That is not a Bitcoin message signature: paste the whole signature, as the wallet shows it", `${BROWSER}/proofs/providers/bitcoin.ts`],
  ["That is not a Bitcoin message signature", `${BROWSER}/proofs/providers/bitcoin.ts`],
  ["The signature is not valid base64", `${CORE}/bip322.ts`],
  ["Enter a DID, like did:key:z6Mk… or did:web:example.com", `${CORE}/did.ts`],
  ["That DID is too long (at most 512 characters)", `${CORE}/did.ts`, "That DID is too long (at most ${DID_MAX_LENGTH} characters)"],
  ["Enter the DID alone, without a #fragment, ?query or /path", `${CORE}/did.ts`],
  ["That is not a DID: it looks like did:<method>:<identifier>", `${CORE}/did.ts`],
  ["Write the method in lowercase: did:key:…", `${CORE}/did.ts`, "Write the method in lowercase: did:${method.toLowerCase()}:…"],
  ["did:plc is not supported yet. Ghostly checks did:key, did:jwk, did:dht and did:web.", `${CORE}/did.ts`, "is not supported yet. Ghostly checks ${METHOD_LIST}."],
  ["A DID has no spaces or other special characters", `${CORE}/did.ts`],
  ["A did:dht identifier is 52 z-base-32 characters", `${CORE}/did.ts`],
  ["That did:key is not an Ed25519, secp256k1 or P-256 key Ghostly can read", `${CORE}/did.ts`],
  ["That did:key is an X25519 encryption key: it cannot sign", `${CORE}/did.ts`],
  ["That did:jwk does not hold a JSON Web Key", `${CORE}/did.ts`],
  ["That did:jwk contains a private key. Never share it: make a new key", `${CORE}/did.ts`],
  ["That did:jwk is not an Ed25519, secp256k1 or P-256 key", `${CORE}/did.ts`],
  ["Enter at least one relay address (https://…)", `${BROWSER}/engine/node.ts`],
  ["Enter at least one relay address (wss://…)", `${BROWSER}/nostr/relay.ts`],
  ["Add a TURN server first", `${BROWSER}/engine/node.ts`],
  ["Hide my IP from contacts needs a TURN server. Turn it off first", `${BROWSER}/engine/node.ts`],
  ["A contact's app does not open in the browser extension while Hide my IP from contacts is on", "apps/extension/src/background.ts"],
  ["A contact's app does not open in the web app while Hide my IP from contacts is on", "apps/web/src/host.ts"],
  ["The profile locked before the contact's app opened", "apps/ui/src/lib/serviceWindows.ts"],
  ["Use an https:// relay address: http://relay.example.org/", `${BROWSER}/platform/irohWeb.ts`, "Use an https:// relay address: ${value}"],
  ["Use an https:// relay address: http://push.example.org/", `${BROWSER}/shared/pushRelay.ts`, "Use an https:// relay address: ${url}"],
  ["Not a relay address: https://relay.example.org/?key=1", `${BROWSER}/platform/irohWeb.ts`, "Not a relay address: ${value}"],
  ["Not a relay address: ftp//x", `${BROWSER}/nostr/relay.ts`, "Not a relay address: ${value.slice(0, 40)}"],
  ["Use an https:// relay address: wss://relay.example.org", `${CORE}/relay.ts`, "`Use an https:// relay address: ${line}`"],
  ["Not a relay address: not a url", `${CORE}/relay.ts`, "`Not a relay address: ${line}`"],
  // What Settings, Network refuses before Save, and the engine on it (agents#2373).
  ["Enter a relay address (wss://…)", `${BROWSER}/shared/hyperdhtRelay.ts`],
  ["Use a wss:// relay address", `${BROWSER}/shared/hyperdhtRelay.ts`],
  ["Not a relay address: wss://relay.example.org/?key=1", `${BROWSER}/shared/hyperdhtRelay.ts`, "Not a relay address: ${url}"],
  ["Enter a relay address (https://…)", `${BROWSER}/shared/pushRelay.ts`],
  ["Leave the user and password out of the address", `${BROWSER}/shared/pushRelay.ts`],
  ["Use at most five Iroh relays", `${BROWSER}/engine/node.ts`],
  ["Enter the TURN server address", `${BROWSER}/shared/ice.ts`],
  ["“https://turn.example.org” is not a TURN or STUN address (turn:host:port)", `${BROWSER}/shared/ice.ts`, "” is not a TURN or STUN address (turn:host:port)"],
  ["A TURN server needs its username and credential", `${BROWSER}/shared/ice.ts`],
  ["No relay answered", `${BROWSER}/engine/nostrSocial.ts`, "throw new Error(\"No relay answered\")"],
  ["No relay answered", `${BROWSER}/profiles/activity.ts`, "throw new Error(\"No relay answered\")"],
  ["No relay answered", `${BROWSER}/profiles/readers.ts`, "throw new Error(\"No relay answered\")"],
  // Held items for an away contact (WISP 404): a message's line, and the chat's hold line and dialog.
  ["An item held for an away contact is at most 8 MB.", `${BROWSER}/engine/hold.ts`, "An item held for an away contact is at most "],
  ["Held messages need S3 storage (Profile → Backups) and a pinned contact.", `${BROWSER}/engine/hold.ts`],
  ["The message is gone", `${BROWSER}/engine/hold.ts`],
  ["The file is gone", `${BROWSER}/engine/hold.ts`],
  ["The payment request is gone", `${BROWSER}/engine/hold.ts`],
  ["Could not store the item: The storage answered 403", `${BROWSER}/engine/hold.ts`, "Could not store the item: "],
  ["Stored, but could not tell the contact where: Failed to fetch", `${BROWSER}/engine/hold.ts`, "Stored, but could not tell the contact where: "],
  ["Held for its whole lifetime without being picked up. Retry to hold it again.", `${BROWSER}/engine/hold.ts`],
  ["Your contact's app refused this item: it could not be verified as yours, or was too large for it. Retry to hold it again.", `${BROWSER}/engine/hold.ts`],
  ["Could not read the contact's pointer: Failed to fetch", `${BROWSER}/engine/hold.ts`, "Could not read the contact's pointer: "],
  ["The contact holds items for you, but their address expired. They are handed out again when the contact is next online.", `${BROWSER}/engine/hold.ts`],
  ["Hide my IP from contacts is on: what your contact held for you waits on their storage until you turn it off.", `${BROWSER}/engine/hold.ts`],
  ["Refused what the contact's storage offered: The manifest is malformed", `${BROWSER}/engine/hold.ts`, "Refused what the contact's storage offered: "],
  ["Could not pick up held items: The storage answered 403", `${BROWSER}/engine/hold.ts`, "Could not pick up held items: "],
  ["Could not pick up held items: the contact's app sealed them for the device this profile was on before. They come once it seals them again for this one.", `${BROWSER}/engine/hold.ts`],
  ["Refused a held item from the contact: The held item is larger than allowed", `${BROWSER}/engine/hold.ts`, "Refused a held item from the contact: "],
  ["Picked up, but could not acknowledge: The storage answered 403", `${BROWSER}/engine/hold.ts`, "Picked up, but could not acknowledge: "],
  // A Lightning card asked for an invoice it could not look up (a Receive, a chat request on it).
  ["Alby Hub cannot look up its invoices, so a payment to it would never be seen: receive with another Lightning card, or connect it with invoice lookup allowed", `${BROWSER}/engine/paymentAdapters/providers/lightningService.ts`, " cannot look up its invoices, so a payment to it would never be seen: receive with another Lightning card, or connect it with invoice lookup allowed"],
  // An OpenPGP key of a kind or size the Add dialog refuses.
  ["This key uses RSA 16384, which Ghostly does not accept. Use Ed25519, ECDSA (P-256, P-384, P-521, brainpool) or RSA with 2048 to 8192 bits.", `${BROWSER}/proofs/openpgp.ts`, ", which Ghostly does not accept. Use Ed25519, ECDSA (P-256, P-384, P-521, brainpool) or RSA with 2048 to ${RSA_MAX_BITS} bits."],
  ["This key uses RSA with a 65-bit public exponent, which Ghostly does not accept. Use a key made by GnuPG (exponent 65537).", `${BROWSER}/proofs/openpgp.ts`, "-bit public exponent, which Ghostly does not accept. Use a key made by GnuPG (exponent 65537)."],
  ["This is an OpenPGP v5 key, which Ghostly does not accept. Use a v4 key (gpg makes Ed25519 ones) or a v6 key.", `${BROWSER}/proofs/openpgp.ts`, " key, which Ghostly does not accept. Use a v4 key (gpg makes Ed25519 ones) or a v6 key."],
  ["This copy of the key has no user IDs (keys.openpgp.org leaves them out until you confirm an email there), so it cannot be checked. Paste your public key instead.", `${BROWSER}/proofs/openpgp.ts`, "This copy of the key has no user IDs (keys.openpgp.org leaves them out until you confirm an email there), so it cannot be checked. Paste your public key instead."],
];

const translators = Object.fromEntries(LANGUAGES.map((l) => [l, translateWith(LOCALES[l], l)]));
const matched = (text: string) => ERROR_RULES.find((rule) => rule.match.test(text));

describe("errors in the app's language", () => {
  it.each(SAMPLES.map(([text, path, part]) => ({ text, path, part: part ?? text })))("$text: still thrown as it is by its source", ({ text, path, part }) => {
    expect(source(path)).toContain(part);
    expect(matched(text), "no rule for it").toBeDefined();
  });

  it.each(LANGUAGES.filter((l) => l !== "en"))("every known error reads in %s, not in English", (language) => {
    const same = SAMPLES.map(([text]) => text).filter((text) => errorText(text, translators[language]) === errorText(text, english));
    expect(same).toEqual([]);
  });

  it.each(LANGUAGES)("no known error leaves a value unfilled in %s", (language) => {
    expect(SAMPLES.map(([text]) => errorText(text, translators[language])).filter((said) => said.includes("{{"))).toEqual([]);
  });

  it("a reason nested in a wallet that could not be made is said in the language, also without its final period", () => {
    const pt = translators.pt;
    expect(errorText("Could not create the Mainnet Cashu wallet: Could not reach mint.example. Check the address: it should be a Cashu mint. Nothing was saved; try again.", pt))
      .toBe("Não foi possível criar a carteira Mainnet Cashu. Sem acesso a mint.example. Confira o endereço: deve ser um mint Cashu. Nada foi salvo. Tente de novo.");
    expect(errorText("Could not connect to BDK: the Esplora server at esplora.example did not answer in 10 s", pt)).toBe("Não foi possível conectar a BDK. O servidor Esplora em esplora.example não respondeu em 10 s");
  });

  // agents#1593: the members a group waits on were pasted as the engine listed them, in English, in every language.
  it("the members a group waits on to grow past 8 are listed in the language: unnamed ones, the list, and how many more", () => {
    const text = "A group grows past 8 only when everyone is on an updated Ghostly. Not seen updated yet: Ana, Bruno, Member q5zt8m3x and 2 more.";
    const pt = errorText(text, translators.pt), ja = errorText(text, translators.ja), en = errorText(text, english);
    expect(pt).toContain("Ana, Bruno, Membro q5zt8m3x e mais 2");
    expect(ja).toContain("他 2 人");
    expect(ja).not.toContain("Member");
    for (const said of [pt, ja]) expect(said).not.toMatch(/ and \d+ more/);
    expect(en).toContain("Ana, Bruno, Member q5zt8m3x, and 2 more");
    // Fewer than four: no tail, and one name alone is just that name.
    expect(errorText("A group grows past 8 only when everyone is on an updated Ghostly. Not seen updated yet: Member abcdefgh.", translators.fr)).toContain("Membre abcdefgh");
  });

  it("a paste the app's clipboard refused says what to do next, in the language", () => {
    const pt = translators.pt;
    expect(errorText("That picture is too large to paste", pt)).toBe("Isso é grande demais para colar. Envie com + → Documento.");
    expect(errorText("That paste is gone. Paste it again.", pt)).toBe("Essa colagem expirou. Cole de novo.");
    expect(errorText("Clipboard unavailable", pt)).toBe("Não foi possível ler a área de transferência. Anexe com +.");
    expect(errorText("Could not read the pasted file: Permission denied (os error 13)", pt)).toBe("Não foi possível ler o arquivo colado. Anexe com +.");
    expect(knownErrorParts("Could not read the pasted file: Permission denied (os error 13)", pt)?.detail).toBe("Could not read the pasted file: Permission denied (os error 13)");
    // A file sent with + whose copy could not be read is not a paste, and is sent again.
    expect(knownErrorParts("Could not read the file: The file changed while it was being copied", english)).toEqual({
      title: "The file cannot be read", next: "Send it again, or pick the file again.", detail: "Could not read the file: The file changed while it was being copied" });
    // A large file this device had no room to copy before sending it: what to free, and that it is picked again.
    expect(knownErrorParts("Not enough space on this device to send it", english)).toEqual({
      title: "Not enough space on this device", next: "Free some space, then pick the file again." });
    expect(knownErrorParts("Not enough space on this device to send it", translators.pt)).toEqual({
      title: "Não há espaço suficiente neste dispositivo", next: "Libere espaço e escolha o arquivo de novo." });
  });

  it.each(LANGUAGES)("a storage that is full when a group is made or a text sent says so and what to do in %s, its name behind the ⓘ", (language) => {
    const t = translators[language];
    const raw = "Not enough space on this device (QuotaExceededError)";
    expect(problemText(new Error(raw), t)).toEqual({ tone: "error", title: t("errors.app.noRoom"), next: t("errors.app.noRoomNext"), detail: raw });
    expect(problemText(new Error(raw), t).title).not.toBe(t("errors.generic"));
  });

  it.each(LANGUAGES)("a forward's copy Desktop's disk had no room for says so in %s, the system's English behind the ⓘ", (language) => {
    const t = translators[language];
    const raw = "Not enough space on this device (No space left on device (os error 28))";
    expect(problemText(new Error(raw), t)).toEqual({ tone: "error", title: t("errors.app.noRoom"), next: t("errors.app.noRoomNext"), detail: raw });
  });

  it("Windows' full disk, as the Desktop's file store says it (file_store.rs io_text), reads as no room on a forward and on a file received", () => {
    const pt = translators.pt;
    const windows = "No space left on device: Não há espaço suficiente no disco. (os error 112)";
    const forward = `Not enough space on this device (${windows})`;
    expect(problemText(new Error(forward), pt)).toEqual({ tone: "error", title: pt("errors.app.noRoom"), next: pt("errors.app.noRoomNext"), detail: forward });
    const received = `Could not store the file: ${windows}`;
    expect(knownErrorParts(received, pt)).toMatchObject({ title: pt("errors.files.noRoomHere"), next: pt("errors.files.noRoomHereNext") });
  });

  it.each(LANGUAGES)("a received file IndexedDB had no room for reads as no room here in %s, however the line was kept", (language) => {
    const t = translators[language];
    const noRoom = { title: t("errors.files.noRoomHere"), next: t("errors.files.noRoomHereNext") };
    // As the engine says it now (named by the error, packages/core chatFiles.ts), with and without the storage's own words.
    for (const raw of [
      "Could not store the file: QuotaExceededError: This device has no room left to save this",
      "Could not store the file: QuotaExceededError",
      // As a received file's record kept it before (the IndexedDB storage's words alone).
      "Could not store the file: This device has no room left to save this",
    ]) expect(knownErrorParts(raw, t), raw).toEqual({ ...noRoom, detail: raw });
  });

  it("a storage that is full says the same with the browser's own message, and reads in English as a sentence and its next step", () => {
    const raw = "Not enough space on this device (QuotaExceededError: The quota has been exceeded.)";
    expect(problemText(new Error(raw), english)).toEqual({ tone: "error", title: "Not enough space on this device", next: "Free some space, then try again.", detail: raw });
  });

  it("a picked file that changed on disk before its copy says it cannot be read and what to do, not the browser's English", () => {
    const pt = translators.pt;
    const changed = "Could not read the file: The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.";
    expect(knownErrorParts(changed, pt)).toEqual({ title: "Não foi possível ler o arquivo", next: "Envie de novo ou escolha o arquivo outra vez.", detail: changed });
  });

  it.each(LANGUAGES)("a HyperDHT relay the web's listener could not use says what to do next in %s: check it in Settings, or ask whoever runs it", (language) => {
    const t = translators[language];
    // A browser sees no status on a refused WebSocket: a relay that leaves this app's origin out reads "unreachable" too.
    expect(knownErrorParts("Could not reach the HyperDHT relay", t)).toEqual({ title: t("errors.transport.hyperdhtUnreachable"), next: t("errors.transport.hyperdhtUnreachableNext") });
    expect(knownErrorParts("The HyperDHT relay did not answer", t)).toEqual({ title: t("errors.transport.hyperdhtSilent"), next: t("errors.transport.hyperdhtCheckNext") });
    expect(knownErrorParts("The HyperDHT relay closed the connection", t)).toEqual({ title: t("errors.transport.hyperdhtClosed"), next: t("errors.transport.hyperdhtCheckNext") });
    expect(knownErrorParts("The HyperDHT relay did not let this chat listen", t)).toEqual({ title: t("errors.transport.hyperdhtRefused"), next: t("errors.transport.hyperdhtRefusedNext") });
    for (const key of ["hyperdhtUnreachableNext", "hyperdhtCheckNext", "hyperdhtRefusedNext"] as const) expect(t(`errors.transport.${key}`)).not.toBe(`errors.transport.${key}`);
  });

  // These were the engine's English in a chat's not-live box, the wallet's Receive, and "Something went wrong" (over
  // `readable`'s length) in Identities → Add → OpenPGP, in every language.
  it.each(LANGUAGES)("a contact's Iroh relay this device does not dial says why and what to do in %s, in the not-live box too", (language) => {
    const t = translators[language];
    const cases: [string, TranslationKey, TranslationKey][] = [
      ["The contact's Iroh relay is not one this device dials", "errors.transport.irohRelayNotDialled", "errors.transport.irohRelayNotDialledNext"],
      ["The contact is not on one of this profile's Iroh relays", "errors.transport.irohNotOwnRelay", "errors.transport.irohNotOwnRelayNext"],
    ];
    for (const [raw, key, next] of cases) {
      expect(problemText(new Error(raw), t), raw).toEqual({ tone: "error", title: t(key), next: t(next) });
      const lines = liveAttemptText({ at: 1, side: "dialled", failed: [{ transport: "iroh/1", error: raw }] }, "you", "Ana", () => "17:02", t)!.lines;
      expect(lines, raw).toEqual([t("connection.attempt.failure", { transport: "Iroh", reason: t(key).replace(/\.$/, "") })]);
    }
  });

  it.each(LANGUAGES)("a Lightning card that cannot look up its invoices says so and what to do in %s, its name kept", (language) => {
    const t = translators[language];
    const raw = "Alby Hub cannot look up its invoices, so a payment to it would never be seen: receive with another Lightning card, or connect it with invoice lookup allowed";
    expect(problemText(new Error(raw), t)).toEqual({ tone: "error", title: t("errors.wallet.noLookup", { label: "Alby Hub" }), next: t("errors.wallet.noLookupNext") });
    expect(knownErrorParts(raw, t)?.title).toContain("Alby Hub");
  });

  it.each(LANGUAGES)("an OpenPGP key of a kind or size Ghostly refuses says so and which keys to use in %s, not \"Something went wrong\"", (language) => {
    const t = translators[language];
    for (const kind of ["RSA 16384", "RSA 1024", "elgamal", "dsa"]) {
      const raw = `This key uses ${kind}, which Ghostly does not accept. Use Ed25519, ECDSA (P-256, P-384, P-521, brainpool) or RSA with 2048 to 8192 bits.`;
      const said = problemText(new Error(raw), t);
      expect(said, raw).toEqual({ tone: "error", title: t("errors.proof.pgpKeyKind", { kind }), next: t("errors.proof.pgpKeyKindNext", { max: "8192" }) });
      expect(said.title).not.toBe(t("errors.generic"));
    }
    const exponent = "This key uses RSA with a 65-bit public exponent, which Ghostly does not accept. Use a key made by GnuPG (exponent 65537).";
    expect(problemText(new Error(exponent), t)).toEqual({ tone: "error", title: t("errors.proof.pgpExponent", { bits: "65" }), next: t("errors.proof.pgpExponentNext") });
    const v5 = "This is an OpenPGP v5 key, which Ghostly does not accept. Use a v4 key (gpg makes Ed25519 ones) or a v6 key.";
    expect(problemText(new Error(v5), t)).toEqual({ tone: "error", title: t("errors.proof.pgpKeyVersion", { version: "5" }), next: t("errors.proof.pgpKeyVersionNext") });
  });

  it.each(LANGUAGES)("a key keys.openpgp.org serves without its user IDs says why it cannot be checked and what to do in %s", (language) => {
    const t = translators[language];
    const raw = "This copy of the key has no user IDs (keys.openpgp.org leaves them out until you confirm an email there), so it cannot be checked. Paste your public key instead.";
    expect(problemText(new Error(raw), t)).toEqual({ tone: "error", title: t("errors.proof.pgpNoUserIds"), next: t("errors.proof.pgpNoUserIdsNext") });
    expect(problemText(new Error(raw), t, "proof").title).not.toBe(t("errors.proof.checkFailed"));
  });

  it.each(LANGUAGES)("a file said on the floor that ended here says why and what to do in %s, never the engine's English", (language) => {
    const t = translators[language];
    const file = { id: "L-in-abc", name: "x.bin", size: 30_000, mime: "application/octet-stream" };
    // As fileDesk.ts `withdrawn` keeps it: failed, with no direction.
    const bubble = (error: string) => {
      const transfer = { state: "failed", transferred: 0, size: 30_000, error } as const;
      return { status: failedStatus(file, transfer, t), info: failedReason(transfer, t) };
    };
    expect(bubble("No room on this device for this file")).toEqual({ status: t("errors.files.noRoomHere"), info: { text: t("errors.files.floor.noRoomNext") } });
    expect(bubble("Too many files are waiting here")).toEqual({ status: t("errors.files.floor.tooMany"), info: { text: t("errors.files.floor.tooManyNext") } });
    expect(bubble("It was refused here")).toEqual({ status: t("errors.files.floor.refused"), info: { text: t("errors.files.askAgain") } });
    expect(bubble("It did not come within a week")).toEqual({ status: t("errors.files.floor.notInAWeek"), info: { text: t("errors.files.askAgain") } });
    expect(bubble("Cancelled by the sender")).toEqual({ status: t("chat.file.cancelled"), info: { text: t("errors.files.askAgain") } });
  });

  it.each(LANGUAGES)("a 1:1 file declined or cancelled says who did it behind its ⓘ in %s, never the engine's English", (language) => {
    const t = translators[language];
    const file = { id: "L-out-abc", name: "x.bin", size: 30_000, mime: "application/octet-stream" };
    const bubble = (error: string, direction: "in" | "out") => {
      const transfer = { state: "failed", direction, transferred: 0, size: 30_000, error } as const;
      return { status: failedStatus(file, transfer, t), info: failedReason(transfer, t) };
    };
    expect(bubble("Declined by your contact", "out")).toEqual({ status: t("chat.file.declined"), info: { text: t("errors.files.declinedThere") } });
    expect(bubble("Cancelled by your contact", "out")).toEqual({ status: t("chat.file.cancelled"), info: { text: t("errors.files.cancelledThere") } });
    expect(bubble("You declined it", "in")).toEqual({ status: t("chat.file.declined"), info: { text: t("errors.files.declinedHere") } });
    expect(bubble("You cancelled it", "in")).toEqual({ status: t("chat.file.cancelled"), info: { text: t("errors.files.cancelledHere") } });
    expect(bubble("You cancelled it", "out")).toEqual({ status: t("chat.file.cancelled"), info: { text: t("errors.files.cancelledHere") } });
    for (const key of ["declinedThere", "cancelledThere", "declinedHere", "cancelledHere"] as const) expect(t(`errors.files.${key}`)).not.toBe(`errors.files.${key}`);
  });

  it("a group's file every holder served damaged says so, and that the group is asked again, not a contact", () => {
    const damaged = "Every copy of this file arrived damaged and was deleted. Ask for it again later.";
    expect(knownErrorParts(damaged, translators.pt)).toEqual({ title: "O arquivo chegou danificado", next: "Peça de novo ao grupo mais tarde." });
    expect(knownErrorParts(damaged, english)).toEqual({ title: "The file arrived damaged", next: "Ask the group for it again later." });
  });

  it("a forward refused for a file still arriving or no longer here says why and what to do, in the language", () => {
    const pt = translators.pt;
    expect(knownErrorParts("The file has not arrived yet", pt)).toEqual({ title: "Ainda não recebido", next: "Espere ele chegar e encaminhe depois." });
    expect(knownErrorParts("The file has not arrived yet", english)).toEqual({ title: "Not received yet", next: "Wait until it has arrived, then forward it." });
    expect(knownErrorParts("The file is not on this device any more", pt)).toEqual({ title: "Este arquivo não está neste dispositivo", next: "Envie de onde você o tem." });
    expect(knownErrorParts("The file is not on this device any more", english)).toEqual({ title: "This file is not on this device", next: "Send it from where you have it." });
  });

  it("an action refused in limited mode says why and what to do, in the language", () => {
    const refused = new Error("Ghostly could not check which device is active yet. This works once it can.");
    expect(knownErrorParts(refused, translators.pt)).toEqual({ title: "Não foi possível verificar qual dispositivo está ativo", next: "Isso volta a funcionar quando a verificação der certo. Confira sua conexão." });
    expect(knownErrorParts(refused, english)).toEqual({ title: "Can't check which device is active", next: "This works once the check does. Check your connection." });
  });

  it("a write the device had no room for says so and that nothing was saved, in the language, not an empty error", () => {
    const full = Object.assign(new Error("This device has no room left to save this"), { name: "QuotaExceededError" });
    expect(knownErrorParts(full, english)).toEqual({ title: "No room left on this device", next: "Nothing was saved. Free some space, then try again." });
    expect(knownErrorParts(full, translators.pt)).toEqual({ title: "Não há mais espaço neste dispositivo", next: "Nada foi salvo. Libere espaço e tente de novo." });
  });

  it("an Invite or a Remove on a device where managing the group is off points at the group's Turn on, in the language", () => {
    const off = new Error("Managing this group is off on this device. Turn on Manage groups from this device first.");
    expect(knownErrorParts(off, english)).toEqual({ title: "Managing this group is off on this device", next: "Turn it on first: Manage groups from this device, on the group's page." });
    expect(knownErrorParts(off, translators.pt)?.title).toBe("Gerenciar este grupo está desligado neste dispositivo");
  });

  it("an Invite to a contact whose app is only closed says to invite them once online, not to update", () => {
    const away = new Error("This contact is not connected right now. Invite them when they are online.");
    expect(knownErrorParts(away, english)).toEqual({ title: "This contact is offline", next: "Invite them when they're online." });
    expect(knownErrorParts(away, translators.pt)).toEqual({ title: "Este contato está offline", next: "Convide quando ele estiver online." });
    const old = new Error("Their app does not take part in groups: they need an updated Ghostly first.");
    expect(knownErrorParts(old, english)).toEqual({ title: "Their app needs an update first", next: "Their app needs groups (an updated Ghostly)." });
  });

  it("a contact's unknown native address with no WebRTC between the two apps says it comes from them, not to reconnect over WebRTC", () => {
    const withRtc = new Error("Peer native address unavailable; reconnect WebRTC once to exchange endpoints");
    expect(knownErrorParts(withRtc, english)?.next).toBe("Reconnect over WebRTC once to exchange it.");
    const noRtc = new Error("Peer native address unavailable; the contact's app has not given it yet");
    expect(knownErrorParts(noRtc, english)).toEqual({ title: "Your contact's address for this transport isn't known yet", next: "It comes once your contact opens this chat in their app.", detail: noRtc.message });
    expect(knownErrorParts(noRtc, translators.pt)?.next).toBe("Chega quando o contato abrir esta conversa no app.");
  });

  it("a part of Ghostly that did not load is said in the language, not in the browser's English", () => {
    const pt = translators.pt;
    for (const raw of ["Failed to fetch dynamically imported module: https://app.ghostly.tools/assets/index-AbC123.js", "Importing a module script failed.", "error loading dynamically imported module: https://app.ghostly.tools/assets/x.js"]) {
      expect(problemText(new TypeError(raw), pt)).toEqual({ tone: "error", title: "Uma parte do Ghostly não carregou.", next: "Verifique sua conexão e tente de novo. Se continuar falhando, recarregue o Ghostly.", detail: raw });
    }
    expect(errorText(new TypeError("Importing a module script failed."), english)).toBe("Part of Ghostly did not load. Check your connection, then try again. If it still fails, reload Ghostly.");
  });

  it("what the Add dialog's field refuses reads in the language, with the names it quotes kept (agents#2222)", () => {
    const ar = translators.ar;
    expect(errorText("The signature is not valid base64", ar)).toBe("التوقيع ليس base64 صالحًا");
    expect(errorText("did:plc is not supported yet. Ghostly checks did:key, did:jwk, did:dht and did:web.", ar)).toBe("did:plc غير مدعوم بعد. يتحقق Ghostly من did:key, did:jwk, did:dht and did:web.");
    expect(errorText("That did:key is not an Ed25519, secp256k1 or P-256 key Ghostly can read", translators.pt)).toBe("Esse did:key não é uma chave Ed25519, secp256k1 ou P-256 que o Ghostly consiga ler");
    expect(errorText("That DID is too long (at most 512 characters)", translators.ja)).toBe("この DID は長すぎます（最大 512 文字）");
    expect(problemText(new Error("That did:jwk contains a private key. Never share it: make a new key"), translators.pt)).toMatchObject({ title: "Esse did:jwk contém uma chave privada", next: "Nunca a compartilhe: crie uma chave nova." });
    // In English, the same words as before.
    expect(errorText("That is not a valid domain name", english)).toBe("That is not a valid domain name");
  });

  // agents#2541: these were "Something went wrong", or the English title, in every language.
  it.each(LANGUAGES)("a domain proof the record, file, resolver or host refused says why and what to do in %s, the English behind the ⓘ", (language) => {
    const t = translators[language];
    const cases: [string, TranslationKey, TranslationKey, Record<string, string>?][] = [
      ["The TXT record at _ghostly.example.com is for another proof of this key", "errors.proof.dnsOtherProof", "errors.proof.dnsValueNext"],
      ["The TXT record at _ghostly.example.com names another Ghostly key: this proof was replaced or removed", "errors.proof.dnsOtherKey", "errors.proof.dnsValueNext"],
      ["https://example.com/.well-known/ghostly.json is for another proof of this key", "errors.proof.fileOtherProof", "errors.proof.fileValueNext"],
      ["https://example.com/.well-known/ghostly.json names another Ghostly key: this proof was replaced or removed", "errors.proof.fileOtherKey", "errors.proof.fileValueNext"],
      ["https://example.com/.well-known/ghostly.json is not a valid Ghostly file", "errors.proof.fileInvalid", "errors.proof.fileInvalidNext", { kind: "Ghostly" }],
      ["https://example.com/.well-known/nostr.json is not a valid NIP-05 file", "errors.proof.fileInvalid", "errors.proof.fileInvalidNext", { kind: "NIP-05" }],
      ["example.com could not be reached. The file must be served at exactly this address, without a redirect, with the header Access-Control-Allow-Origin: *", "errors.proof.hostUnreachable", "errors.proof.hostUnreachableNext", { domain: "example.com" }],
      ["Quad9 could not be reached", "errors.proof.resolverUnreachable", "errors.proof.resolverNext"],
      ["Quad9 refused the lookup", "errors.proof.resolverRefused", "errors.proof.resolverNext"],
      ["example.com has no address", "errors.proof.noAddress", "errors.proof.noAddressNext", { domain: "example.com" }],
      ["example.com points to a private network address, so it was not contacted", "errors.proof.privateAddress", "errors.proof.privateAddressNext", { domain: "example.com" }],
    ];
    for (const [raw, key, next, values] of cases) {
      expect(problemText(new Error(raw), t), raw).toEqual({ tone: "error", title: t(key, values), next: t(next, values), detail: raw });
    }
    // The lookup that ran out of time on the last resolver tried says that none answered, not that one's name.
    for (const resolver of ["Quad9", "Cloudflare", "Google"]) {
      const said = problemText(new Error(`${resolver} could not be reached`), t);
      expect(said.title).toBe(t("errors.proof.resolverUnreachable"));
      expect(`${said.title} ${said.next}`).not.toContain(resolver);
    }
  });

  it("a Lightning address's invoice for another amount says so and what to do, in the language; the amounts stay behind the ⓘ", () => {
    for (const raw of ["The invoice asks for 1,234,567 sats, not the 21,000 sats you chose", "The invoice asks for any amount, not the 21 sats you chose"]) {
      expect(knownErrorParts(raw, translators.pt)).toEqual({ title: "A fatura não bate com o valor que você escolheu", next: "Nada foi pago. Tente de novo ou pague de outro jeito.", detail: raw });
      expect(knownErrorParts(raw)).toEqual({ title: "The invoice does not match the amount you chose", next: "Nothing was paid. Try again, or pay another way.", detail: raw });
    }
  });

  it.each(["pt", "ar"] as const)("why a contact's proof failed this app's check reads in %s: every reason its verify paths throw, never the English", (language) => {
    const t = translators[language];
    // Every plain string thrown in the verify paths, besides the reasons above (template ones are there with values).
    const files = ["verify.ts", "sshForges.ts", "pubky.ts", "domain.ts", "did.ts", "openpgp.ts", "atproto/resolve.ts", "oidc/verify.ts", "oidc/jwks.ts", ...["atproto", "bitcoin", "did", "domain", "nostr", "oidc", "openpgp", "pubky", "ssh"].map((p) => `providers/${p}.ts`)]
      .map((file) => `${BROWSER}/proofs/${file}`).concat(`${CORE}/identityProofs.ts`);
    const thrown = files.flatMap((file) => [...source(file).matchAll(/(?:throw new \w+|refuse)\((["'])((?:(?!\1)[^\\])+)\1\)/g)].map((m) => m[2]!));
    expect(thrown.length).toBeGreaterThan(100);
    const english = [...new Set([...PROOF_REASONS.map(([text]) => text), ...thrown])].filter((raw) => problemLine(raw, t, "proof").includes(raw));
    expect(english).toEqual([]);
    // A reason the rules do not know is a translated "could not verify", its English only behind the ⓘ.
    expect(problemText("The Nostr event id does not match its content", t, "proof")).toEqual({ tone: "error", title: t("errors.proof.checkFailed"), detail: "The Nostr event id does not match its content" });
    expect(problemLine("The Nostr event id does not match its content", t, "proof")).toBe(t("errors.proof.checkFailed"));
  });

  // A refusal written in a chat's or a group's payments reached the bubble and the composer in English in every language.
  it.each(["pt", "ar"] as const)("every refusal a chat's or a group's payments throw, refuse or store reads in %s, not in English", (language) => {
    const t = translators[language];
    // Never shown to a person: a check of the engine's own state, or a line whose bubble is gone with it.
    const INTERNAL = new Set([
      "Cashu chat recipient missing", "Cashu outbox does not match the reviewed payment", "Fedimint ecash goes to a contact in a chat",
      "The Fedimint payment is not in the journal", "Unsupported payment method", "Removed here", "Choose one member to pay",
    ]);
    const said = ["payments.ts", "communityPay.ts"].flatMap((file) => [...source(`${BROWSER}/engine/${file}`)
      .matchAll(/(?:throw new \w+\(|refuse\(|error: ?|reason: ?|return |const [A-Z_]+ = )(["'])([A-Z](?:(?!\1)[^\\])* (?:(?!\1)[^\\])+)\1/g)].map((m) => m[2]!));
    expect(said.length).toBeGreaterThan(40);
    expect([...new Set(said)].filter((raw) => !INTERNAL.has(raw) && knownErrorText(raw, t) === null)).toEqual([]);
  });

  it("a payee's refusal on the payer's bubble says what to do next, in the language", () => {
    const pt = translators.pt;
    expect(problemLine("Too many payments at once: send it again in a minute", pt)).toBe("Muitos pagamentos ao mesmo tempo. Envie de novo daqui a um minuto.");
    expect(problemLine("Too many open USDT requests of this amount: wait for one to be paid", pt)).toBe("Muitos pedidos de USDT abertos com este valor. Espere um deles ser pago.");
    expect(problemLine("The mint quoted another amount than this invoice's. Nothing was paid.", english)).toBe("The mint quoted another amount than the invoice. Nothing was paid.");
    expect(problemLine("They take no way of paying this device allows.", english)).toBe(english("payments.group.why.noWay"));
  });

  it.each(LANGUAGES)("a contact's proof check that could not run never reads as a bad proof in %s, and the host stays a value (agents#3781)", (language) => {
    const t = translators[language];
    const bad = PROOF_UNAVAILABLE.map(([raw]) => raw).filter((raw) => problemText(raw, t, "proof").title === t("errors.proof.checkFailed"));
    expect(bad).toEqual([]);
    expect(problemLine("github.com could not be reached: Failed to fetch", t, "proof")).toBe(sentences(t("errors.proof.hostUnreachable", { domain: "github.com" }), t("errors.proof.laterNext"), t));
    expect(problemLine("The homeserver homeserver.pubky.app answered 502", t, "proof")).toBe(sentences(t("errors.proof.hostAnswered", { domain: "homeserver.pubky.app" }), t("errors.proof.laterNext"), t));
    // The address the contact chose is behind the ⓘ only.
    expect(problemLine("example.org answered 503 for https://example.org/.well-known/did.json", t, "proof")).not.toContain("https://");
  });

  it("each rule has a sample, so none stops matching unseen", () => {
    const covered = new Set(SAMPLES.map(([text]) => matched(text)));
    expect(ERROR_RULES.filter((rule) => !covered.has(rule)).map((rule) => String(rule.match))).toEqual([]);
  });

  it("a message nested in another is said in the language too, and the numbers and names stay", () => {
    const pt = translators.pt;
    expect(errorText("No mint could create an invoice: mint.example did not answer", pt)).toBe("Nenhum mint conseguiu criar uma fatura. mint.example não respondeu");
    expect(errorText("The Lightning payment did not go through. The sats are back in your wallet, less 2 sats the mint kept as its fee.", pt))
      .toBe("O pagamento Lightning não foi concluído. Os sats voltaram; o mint ficou com 2.");
    for (const translate of Object.values(translators)) {
      expect(errorText("Invoice already paid The sats are back in your wallet, less 1 sat the mint kept as its fee.", translate)).not.toMatch(/\b1 sats/);
    }
    expect(errorText("Refused: Already paid by another member of the group. 1200 sats came back; the mint kept 2 as its fee.", pt))
      .toBe("O pagamento foi recusado. Já foi pago por outro membro do grupo. 1.200 sats voltaram; o mint ficou com 2.");
    expect(errorText("You sent many files to this group just now. Wait 7 minutes.", pt)).toBe("Você enviou muitos arquivos a este grupo agora há pouco. Espere 7 minutos e envie de novo.");
    expect(errorText("Both peers need on-chain Bitcoin on a connected data link", pt)).toBe("Você e seu contato precisam de Bitcoin on-chain, com a conversa ao vivo");
    expect(errorText("This pays with real money: confirm it with Send real money first. Nothing was sent.", pt)).toContain("Enviar dinheiro real");
  });

  it("the \"Error: \" String(error) adds on the way through the extension goes, and an unknown message stays as it came", () => {
    expect(rawError("Error: The Ghostly peer did not start. Reopen the extension to retry.")).toBe("The Ghostly peer did not start. Reopen the extension to retry.");
    expect(errorText(new Error("Error: Ghostly needs your permission to reach that local address"), translators.pt))
      .toBe("O Ghostly precisa da sua permissão para acessar esse endereço local");
    expect(errorText(new Error("Relay said: rate limited"), translators.pt)).toBe("Relay said: rate limited");
    expect(errorText("plain", translators.fr)).toBe("plain");
    expect(errorText(42, translators.fr)).toBe("42");
  });

  // The Share form showed these as "Something went wrong." and the engine's English, in every language.
  it("the Share form's address and name refusals read in the language, with what to type", () => {
    const pt = translators.pt;
    const next = "Use um endereço deste computador, como localhost:3400.";
    expect(problemLine(new Error("Not a valid URL"), pt)).toBe(`Não deu para ler esse endereço. ${next}`);
    expect(problemLine(new Error("Only http and https targets are supported"), pt)).toBe(`Só endereços web (http ou https) podem ser compartilhados. ${next}`);
    expect(problemLine(new Error("Credentials in the target URL are not supported"), pt)).toBe(`O endereço não pode ter usuário nem senha. ${next}`);
    expect(problemLine(new Error("Only services on this machine can be shared (localhost, 127.0.0.1 or [::1])"), pt)).toBe(`Só serviços deste computador podem ser compartilhados. ${next}`);
    expect(problemLine(new Error("The target cannot contain a query or fragment"), pt)).toBe(`O endereço não pode ter uma parte com ? ou #. ${next}`);
    expect(problemLine(new Error("Port 0 is not a port a web app can listen on"), pt)).toBe(`Nenhum app web escuta na porta 0. ${next}`);
    expect(problemLine(new Error("Give the service a name"), pt)).toBe("Dê um nome ao serviço");
  });
});

describe("the engine's known errors (@ghostly/core ENGINE_ERRORS)", () => {
  const SAMPLE: Record<string, string> = { wallet: "Bark", device: "Desktop", host: "mint.example.com", domain: "shop.example", chain: "mutinynet", network: "Testnet", amount: "1,000", fee: "1200", min: "5", max: "500", reason: "Lightning payment failed: no route" };
  const texts = (Object.keys(ENGINE_ERRORS) as EngineErrorCode[]).map((code) => [code, engineText(code, Object.fromEntries([...ENGINE_ERRORS[code].matchAll(/\{(\w+)\}/g)].map(([, name]) => [name, SAMPLE[name]])))] as const);

  it.each(LANGUAGES.filter((l) => l !== "en"))("every one reads in %s, by a rule or by its code", (language) => {
    expect(texts.filter(([, text]) => errorText(text, translators[language]) === text).map(([code]) => code)).toEqual([]);
  });

  // The app says them its own short way in English too (a title and a next line, lib/problemText.ts): each is known,
  // and none leaves a value unfilled.
  it("in English each is known, and keeps its values", () => {
    for (const [, text] of texts) {
      const parts = knownErrorParts(text, english);
      expect(parts, text).not.toBeNull();
      expect(`${parts!.title} ${parts!.next ?? ""}`).not.toContain("{{");
    }
    expect(errorText("Could not reach mint.example.com. Check the address: it should be a Cashu mint.", english)).toBe("Can't reach mint.example.com. Check the address: it should be a Cashu mint.");
  });

  it("a reviewed payment's refusals and outcomes are said in the language too", () => {
    const pt = translators.pt;
    expect(errorText("Cashu fee exceeds your limit", pt)).toBe("A taxa do Cashu passa do seu limite");
    expect(errorText(new Error("The fee exceeds your limit"), pt)).toBe("A taxa passa do seu limite");
    expect(errorText("Error: Unknown payment intent", pt)).toBe("Pagamento desconhecido");
    expect(errorText("Outcome unknown. Check the existing payment; do not send another.", translators.fr)).toContain("Résultat inconnu");
  });

  it("a mint's refusal of a Lightning payment says, in the language, that no sats left; its own words go behind the ⓘ (agents#2253)", () => {
    const raw = engineText("lightningRefused", { reason: "Lightning payment failed: no route" });
    expect(problemText(new Error(raw), translators.pt)).toEqual({ tone: "error", title: "A mint recusou este pagamento Lightning", next: "Nenhum sat saiu da sua carteira. Pode tentar de novo com segurança.", detail: raw });
    expect(problemText(new Error(raw), english)).toEqual({ tone: "error", title: "The mint refused this Lightning payment", next: "No sats left your wallet. It's safe to try again.", detail: raw });
    for (const language of LANGUAGES) expect(errorText(raw, translators[language]), language).not.toContain("no route");
  });

  it("a mint that failed a quote or the faucet is named with the next step, in the language; its own words go behind the ⓘ", () => {
    const values = { host: "testnut.cashu.space", reason: "fetch failed (other side closed, UND_ERR_SOCKET) at https://testnut.cashu.space" };
    const quote = engineText("mintFailedQuote", values), faucet = engineText("mintFailedFaucet", values);
    expect(problemText(new Error(quote), translators.pt)).toEqual({ tone: "error", title: "testnut.cashu.space não conseguiu aceitar este pagamento agora", next: "Nenhum sat saiu da sua carteira. Tente de novo mais tarde.", detail: quote });
    expect(problemText(new Error(faucet), english)).toEqual({ tone: "error", title: "testnut.cashu.space couldn't give test coins right now", next: "Try again later.", detail: faucet });
    for (const language of LANGUAGES) for (const raw of [quote, faucet]) expect(errorText(raw, translators[language]), language).not.toContain("UND_ERR");
  });

  it("a mint that has not answered a payment's or a redeem's swap is named, with what comes back, in the language: not \"Something went wrong\"", () => {
    const pay = "testnut.cashu.space has not answered yet. The payment was not made. The sats set aside for it return to your wallet a few minutes after the mint answers.";
    const redeem = "testnut.cashu.space has not answered yet. The ecash is added to your wallet as soon as it does.";
    expect(problemText(new Error(pay), english)).toEqual({ tone: "error", title: "testnut.cashu.space hasn't answered yet", next: "The payment wasn't made. The sats set aside for it come back to your wallet a few minutes after the mint answers." });
    expect(problemText(new Error(redeem), translators.pt)).toEqual({ tone: "error", title: "testnut.cashu.space ainda não respondeu", next: "O ecash entra na sua carteira assim que ele responder." });
    for (const language of LANGUAGES) for (const raw of [pay, redeem]) {
      const { title, next } = problemText(new Error(raw), translators[language]);
      expect(title, language).toContain("testnut.cashu.space");
      expect(next, language).toBeTruthy();
    }
  });

  it("a contact with no wallet, or none of its ways on, reads as the chat's payment line says it", () => {
    expect(errorText("Your contact has no wallet yet: they need one to pay or be paid", translators.pt)).toBe("Seu contato ainda não tem carteira");
    expect(errorText("Your contact has payments off in this chat, or needs an updated Ghostly", english)).toBe(english("chat.payments.offOrOld"));
  });

  it.each([
    ["en", "Nothing to take back"], ["pt", "Não há nada para pegar de volta"], ["es", "No hay nada que recuperar"], ["fr", "Rien à reprendre"],
    ["it", "Niente da riprendere"], ["ja", "取り戻すものはありません"], ["zh", "没有可取回的内容"], ["ar", "لا يوجد ما يُستعاد"],
  ] as const)("Take it back with nothing left says so with the button's verb in %s, not Redeem's, on Cashu as on Fedimint", (language, said) => {
    expect(errorText("Nothing to reclaim", translators[language])).toBe(said);
    expect(errorText("Nothing to take back", translators[language])).toBe(said);
  });

  it("the values stay, and amounts are written the app's way", () => {
    expect(errorText("shop.example takes between 5 and 1,000,000 sats", translators.pt)).toBe("shop.example aceita de 5 a 1.000.000 sats");
    expect(errorText("Could not reach rpc.example", translators.pt)).toBe("Não foi possível acessar rpc.example");
    expect(errorText("This federation is on mutinynet, a test network: it belongs in a Testnet Fedimint wallet", translators.fr)).toContain("mutinynet");
  });
});
