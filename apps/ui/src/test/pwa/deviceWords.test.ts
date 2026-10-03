import { describe, expect, it } from "vitest";
import { DEVICE_NOTICE_DEFAULTS, pushNotice, type NoticeDevice } from "../../../../web/src/sw/policy";
import { deviceNoticeWords } from "../../../../web/src/sw/deviceWords";

// covers: devices.push, devices.screens

/*
 * The push worker's words on a device that was never active (WISP 06 § Push and the phone): no page of the profile wrote
 * its own yet, so they come from the app's translations in the browser's language, and a page's words win once written.
 */

const standby: NoticeDevice = { state: "standby", active: "MacBook", tokens: {} };
const options = { now: 1_800_000_000_000, appVisible: false, profile: "" };
const wake = { token: "t".repeat(22), kind: "message" as const };

describe("the quiet notices before any page wrote its words", () => {
  it("are in the browser's language, with the worker's {device} in place of the app's {{device}}", () => {
    const pt = deviceNoticeWords(["pt-BR", "en-US"]);
    expect(pt.standby).toBe("Nova mensagem. Ativo em {device}.");
    expect(pushNotice(wake, undefined, standby, { ...options, text: pt })?.body).toBe("Nova mensagem. Ativo em MacBook.");
    expect(deviceNoticeWords(["ja"]).takeover).toContain("{device}");
    for (const words of [["ar"], ["es"], ["fr"], ["it"], ["ja"], ["zh-CN"]].map(deviceNoticeWords)) {
      expect(Object.keys(words).sort()).toEqual(Object.keys(DEVICE_NOTICE_DEFAULTS).sort());
      for (const text of Object.values(words)) expect(text).not.toContain("{{");
    }
  });

  it("are English for a language the app does not speak, the same as the worker's own defaults", () => {
    expect(deviceNoticeWords(["de-DE", "nl"])).toEqual(DEVICE_NOTICE_DEFAULTS);
    expect(deviceNoticeWords([])).toEqual(DEVICE_NOTICE_DEFAULTS);
  });

  it("give way to the words a page wrote in the app's language", () => {
    const text = { ...deviceNoticeWords(["pt-BR"]), standby: "Mensaje nuevo. Activo en {device}." };
    expect(pushNotice(wake, undefined, standby, { ...options, text })?.body).toBe("Mensaje nuevo. Activo en MacBook.");
  });
});
