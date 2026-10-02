import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_ERRORS, engineText, type EngineErrorCode } from "@ghostly/core";
import { ERROR_RULES, errorText, rawError } from "../../lib/errorText";
import { english } from "../../lib/english";
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
/** The engine's known errors, written once with their codes (@ghostly/core ENGINE_ERRORS) and thrown from there. */
const CODES = "packages/core/src/engineErrors.ts";
/** [message as thrown, the file that throws it, the part of the message written there as it is]. */
const SAMPLES: readonly (readonly [string, string, string?])[] = [
  ["The Ghostly peer did not start. Reopen the extension to retry.", "apps/extension/src/background.ts"],
  ["The Ghostly peer is unavailable. Reopen the extension to retry.", "apps/extension/src/host.ts"],
  ["Switching profiles…", "apps/extension/src/host.ts"],
  ["Ghostly needs the sign-in permission for this.", "apps/extension/src/oidc.ts"],
  ["Sign-in was cancelled.", "apps/extension/src/atproto.ts"],
  ["Sign-in cancelled", "apps/extension/src/oidc.ts"],
  ["Could not open a wallet", "apps/extension/src/host.ts"],
  ["Could not open the service", "apps/extension/src/host.ts"],
  ["Could not open a tab", "apps/extension/src/background.ts"],
  ["Not a payment link", "apps/extension/src/background.ts"],
  ["Ghostly is starting…", `${BROWSER}/platform/engine.ts`],
  ["Lost the Ghostly peer", `${BROWSER}/platform/engine.ts`],
  ["Ghostly is still starting. Try again in a moment.", `${BROWSER}/platform/services.ts`],
  ["Ghostly needs your permission to reach that local address", `${BROWSER}/platform/services.ts`],
  ["Pick a Lightning card first", `${BROWSER}/platform/services.ts`],
  ["This client cannot install updates", `${BROWSER}/platform/updates.ts`],
  ["Connect to an updated peer to send files", `${BROWSER}/platform/services.ts`],
  ["Connect to an updated peer first", `${BROWSER}/platform/services.ts`],
  ["That recording cannot be sent as a voice message", `${BROWSER}/platform/services.ts`],
  ["This file cannot be retried", `${BROWSER}/platform/services.ts`],
  ["This file is no longer here", `${BROWSER}/platform/services.ts`],
  ["Not enough space on your contact's device for this file (2.0 MB free).", `${BROWSER}/platform/services.ts`, "Not enough space on your contact's device for this file ("],
  ["That file is too large for your contact's app (max 64 MB). Larger files need an updated Ghostly on their side.", `${BROWSER}/platform/services.ts`, ". Larger files need an updated Ghostly on their side."],
  ["That file is too large (max 64 MB).", `${BROWSER}/platform/services.ts`, "That file is too large (max "],
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
  ["Select a configured mint", `${BROWSER}/engine/wallet.ts`],
  ["That is not a valid ecash token", `${BROWSER}/engine/wallet.ts`],
  ["Ecash from mint.example is not accepted", `${BROWSER}/engine/wallet.ts`, " is not accepted"],
  ["Add a mint in Settings first", `${BROWSER}/engine/wallet.ts`],
  ["Not enough sats in your wallet", CODES],
  ["The Lightning payment did not go through. The sats are back in your wallet.", `${BROWSER}/engine/wallet.ts`, "The sats are back in your wallet."],
  ["The Lightning payment did not go through. The sats are back in your wallet, less 2 sats the mint kept as its fee.", `${BROWSER}/engine/wallet.ts`, "The sats are back in your wallet, less "],
  // Never alone: the start of the two above, said on its own before what came back.
  ["The Lightning payment did not go through.", `${BROWSER}/engine/wallet.ts`, "The Lightning payment did not go through. ${"],
  ["This invoice is already being paid", `${BROWSER}/engine/wallet.ts`],
  ["A Lightning payment from this wallet is still in flight: wait for it to settle, then remove the wallet.", `${BROWSER}/engine/wallet.ts`],
  ["Cashu is off in this chat", `${BROWSER}/engine/payments.ts`],
  ["Both peers need USDT support on a connected data link", `${BROWSER}/engine/payments.ts`],
  ["Both peers need on-chain Bitcoin on a connected data link", `${BROWSER}/engine/payments.ts`],
  ["Join a federation first (Wallet → New → Testnet Fedimint)", `${BROWSER}/engine/payments.ts`, "Join a federation first (Wallet → New → "],
  ["You have no Mainnet Cashu wallet: create one in Wallet → New", `${BROWSER}/engine/payments.ts`, " wallet: create one in Wallet → New"],
  ["Your contact has no Testnet on-chain Bitcoin wallet", `${BROWSER}/engine/payments.ts`, "Your contact has no "],
  ["Mainnet Lightning is off in this chat", `${BROWSER}/engine/payments.ts`, " is off in this chat"],
  ["Lightning is not allowed by both of you here", `${BROWSER}/engine/payments.ts`, " is not allowed by both of you here"],
  ["Your contact allowed neither Cashu nor Lightning in this chat", `${BROWSER}/engine/payments.ts`],
  ["Your contact took no Cashu or Lightning last time. Try again once the chat is live", `${BROWSER}/engine/payments.ts`],
  ["Cashu and Lightning are off in this chat", `${BROWSER}/engine/payments.ts`],
  ["A request to the group is paid in Cashu or over Lightning", `${BROWSER}/engine/payments.ts`],
  ["Unknown payment request", `${BROWSER}/engine/payments.ts`],
  ["Review and explicitly approve this payment before sending", `${BROWSER}/engine/payments.ts`],
  ["This request is no longer open", `${BROWSER}/engine/payments.ts`],
  ["A Lightning payment for this request is still pending", `${BROWSER}/engine/payments.ts`],
  ["You already paid this request", `${BROWSER}/engine/payments.ts`],
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
  ["This is a Mainnet payment (real money): a Testnet wallet never pays it. Use a Mainnet wallet.", `${BROWSER}/engine/paymentAdapters/walletInstances.ts`, "payment (${"],
  ["This is a Testnet payment (test coins): a Mainnet wallet never pays it. Use a Testnet wallet.", `${BROWSER}/engine/paymentAdapters/walletInstances.ts`, "wallet never pays it. Use a "],
  ["This pays with real money: confirm it with Send real money first. Nothing was sent.", CODES],
  ["Could not create the Spark wallet: the network is down. Nothing was saved; try again.", `${BROWSER}/engine/paymentAdapters/walletInstances.ts`, ". Nothing was saved; try again."],
  ["You were removed from this group", `${CORE}/groupSession.ts`],
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
  ["This contact is already a member", `${BROWSER}/engine/groups.ts`],
  ["A group holds 32 members at most", `${BROWSER}/engine/groups.ts`, " members at most"],
  ["Connect to this contact first. Their app needs groups (an updated Ghostly).", `${BROWSER}/engine/groups.ts`],
  ["The contact who invited you is not connected. Try again when they are.", `${BROWSER}/engine/groups.ts`],
  ["You are the admin and nobody else in the group is online to take over. Try again when a member is, or make someone the admin first.", `${BROWSER}/engine/groups.ts`],
  ["Nobody in the group is connected right now to take your leave. Try again in a moment.", `${BROWSER}/engine/community.ts`],
  ["Only the admin can share a link to the group", `${BROWSER}/engine/groups.ts`],
  ["This is not a link to a group", `${BROWSER}/engine/groups.ts`],
  ["You are already joining this group", `${BROWSER}/engine/groups.ts`],
  ["This group is joined with its current link", `${BROWSER}/engine/groups.ts`],
  ["Only the admin can change the members of this group", `${CORE}/groupSession.ts`],
  ["Only the admin can do that", `${CORE}/groupCommunity.ts`],
  ["Make someone else the admin before leaving", `${CORE}/groupSession.ts`],
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
  ["Give the profile a name", "apps/ui/src/lib/profiles.ts"],
  ["That profile already exists", "apps/ui/src/lib/profiles.ts"],
  ["The first profile cannot be removed", "apps/ui/src/lib/profiles.ts"],
  ["The first profile cannot be deleted", "apps/ui/src/lib/profileData.ts"],
  ["Switch to another profile first", "apps/ui/src/lib/profiles.ts"],
  ["Unknown profile", "apps/ui/src/lib/profiles.ts"],
  ["This profile is open in another window. Close it, then try again.", "apps/ui/src/lib/profileData.ts"],
  ["Wrong lock password for that profile", "apps/ui/src/lib/profileData.ts"],
  ["This backup does not hold a profile", "apps/ui/src/lib/profileBackup.ts"],
  ["This device has no room left for this backup. Free some space, then try again.", "apps/ui/src/lib/profileBackup.ts"],
  ["Could not read the Ark wallet for the backup: quota exceeded", "apps/ui/src/lib/profileBackup.ts", "Could not read the Ark wallet for the backup: "],
  ["This wallet has no recovery phrase to show", "apps/ui/src/components/wallet/walletPhrase.ts"],
  ["This wallet has no backup file", "apps/ui/src/components/wallet/walletPhrase.ts"],
  ["Choose a picture", "apps/ui/src/lib/avatarImage.ts"],
  ["That picture is too large (max 20 MB)", "apps/ui/src/lib/avatarImage.ts"],
  ["This picture cannot be read here. Try a JPEG or PNG.", "apps/ui/src/lib/avatarImage.ts"],
  ["This picture cannot be read here", "apps/ui/src/lib/avatarImage.ts"],
  ["This picture could not be made small enough", "apps/ui/src/lib/avatarImage.ts"],
  ["That is too large to paste. Send it with + → Document.", "apps/ui/src/lib/pastedFiles.ts"],
  ["This browser cannot wake Ghostly while it is closed.", "apps/ui/src/lib/wakePush.ts"],
  ["Your signer holds a different key than this identity. Nothing was published.", "apps/ui/src/lib/nostr.ts"],
  ["This device cannot decode the recording", "apps/ui/src/lib/voiceMp3.ts"],
  ["That update is no longer available", "apps/ui/src/desktop/updates.ts"],
  ["The video took too long", "apps/ui/src/lib/videoPoster.ts"],
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

  it("each rule has a sample, so none stops matching unseen", () => {
    const covered = new Set(SAMPLES.map(([text]) => matched(text)));
    expect(ERROR_RULES.filter((rule) => !covered.has(rule)).map((rule) => String(rule.match))).toEqual([]);
  });

  it("a message nested in another is said in the language too, and the numbers and names stay", () => {
    const pt = translators.pt;
    expect(errorText("No mint could create an invoice: mint.example did not answer", pt)).toBe("Nenhum mint conseguiu criar uma fatura: mint.example não respondeu");
    expect(errorText("The Lightning payment did not go through. The sats are back in your wallet, less 2 sats the mint kept as its fee.", pt))
      .toBe("O pagamento Lightning não foi concluído. Os sats voltaram para a sua carteira, menos 2 sats que o mint ficou de taxa.");
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
});

describe("the engine's known errors (@ghostly/core ENGINE_ERRORS)", () => {
  const SAMPLE: Record<string, string> = { host: "mint.example.com", domain: "shop.example", chain: "mutinynet", network: "Testnet", amount: "1,000", fee: "1200", min: "5", max: "500" };
  const texts = (Object.keys(ENGINE_ERRORS) as EngineErrorCode[]).map((code) => [code, engineText(code, Object.fromEntries([...ENGINE_ERRORS[code].matchAll(/\{(\w+)\}/g)].map(([, name]) => [name, SAMPLE[name]])))] as const);

  it.each(LANGUAGES.filter((l) => l !== "en"))("every one reads in %s, by a rule or by its code", (language) => {
    expect(texts.filter(([, text]) => errorText(text, translators[language]) === text).map(([code]) => code)).toEqual([]);
  });

  it("in English each is the engine's own text, word for word", () => {
    for (const [, text] of texts) expect(errorText(text, english)).toBe(text);
  });

  it("a reviewed payment's refusals and outcomes are said in the language too", () => {
    const pt = translators.pt;
    expect(errorText("Cashu fee exceeds your limit", pt)).toBe("A taxa do Cashu passa do seu limite");
    expect(errorText(new Error("The fee exceeds your limit"), pt)).toBe("A taxa passa do seu limite");
    expect(errorText("Error: Unknown payment intent", pt)).toBe("Pagamento desconhecido");
    expect(errorText("Outcome unknown. Check the existing payment; do not send another.", translators.fr)).toContain("Résultat inconnu");
  });

  it("the values stay, and amounts are written the app's way", () => {
    expect(errorText("shop.example takes between 5 and 1,000,000 sats", translators.pt)).toBe("shop.example aceita de 5 a 1.000.000 sats");
    expect(errorText("Could not reach rpc.example", translators.pt)).toBe("Não foi possível acessar rpc.example");
    expect(errorText("This federation is on mutinynet, a test network: it belongs in a Testnet Fedimint wallet", translators.fr)).toContain("mutinynet");
  });
});
