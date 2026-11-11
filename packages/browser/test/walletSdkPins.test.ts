import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { WALLET_SDK_PINS } from "../src/devices/handoffHost";
// covers: devices.handoff.wallets

// WISP 06 § Versions: a wallet whose SDK pin differs between two devices stays home. A pin left behind when the SDK
// moves lets a wallet database the new SDK upgraded move to a device whose SDK cannot open it.
const dependencies = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies: Record<string, string> }).dependencies;
const PACKAGES: Record<string, string> = { bark: "@secondts/bark", breez: "@breeztech/breez-sdk-spark" };

it.each(Object.entries(PACKAGES))("the %s pin is the version packages/browser installs", (pin, name) => {
  expect(WALLET_SDK_PINS[pin]).toBe(dependencies[name]);
});
