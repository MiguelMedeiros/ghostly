import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { OPUS_EXPECTED_LOSS_PERCENT, opusCodec, type OpusNative } from "../src/calls/media";

/*
 * agents#1741: the CLI's Opus encoder sent no in-band FEC, though its SDP says `useinbandfec=1`: on a lossy link every
 * lost packet of a bot's voice was concealed at the contact's app (10% of the time at 10% loss, 1.3% with FEC on).
 */

const OPUS_GET_INBAND_FEC = 4013, OPUS_GET_PACKET_LOSS_PERC = 4015;

/** A codec's encoder as libopus holds it: what it says when asked. */
function encoderSays(native: OpusNative, ctl: number, handler: { _encoder_ctl(ctl: number, value: number): number }): number {
  const at = native._malloc(4);
  try {
    expect(handler._encoder_ctl(ctl, at)).toBe(0);
    return new DataView(native.HEAPU8.buffer, at, 4).getInt32(0, true);
  } finally { native._free(at); }
}

describe("the CLI's Opus encoder", () => {
  it("turns in-band FEC on and plans for the loss it does not measure, as the SDP says", () => {
    const native = (createRequire(import.meta.url)("opusscript/build/opusscript_native_wasm.js") as () => OpusNative)();
    // The handler the codec makes: caught as the module makes it.
    let made: { _encoder_ctl(ctl: number, value: number): number } | undefined;
    const Handler = native.OpusScriptHandler;
    const watched = Object.assign(Object.create(native) as OpusNative, {
      OpusScriptHandler: Object.assign(function (this: unknown, rate: number, channels: number, application: number) {
        made = new Handler(rate, channels, application);
        return made;
      }, { destroy_handler: (handler: unknown) => Handler.destroy_handler(handler as never) }) as unknown as OpusNative["OpusScriptHandler"],
    });
    const codec = opusCodec(watched, 48000);
    try {
      expect(encoderSays(native, OPUS_GET_INBAND_FEC, made!)).toBe(1);
      expect(encoderSays(native, OPUS_GET_PACKET_LOSS_PERC, made!)).toBe(OPUS_EXPECTED_LOSS_PERCENT);
      // It still encodes a 20 ms frame of speech-like sound, within the 32 kb/s budget (80 bytes a frame).
      const frame = new Uint16Array(960).map((_, i) => (Math.round(8000 * Math.sin((2 * Math.PI * 660 * i) / 48000)) + 65536) % 65536);
      const sizes = Array.from({ length: 10 }, () => codec.encode(Buffer.from(frame.buffer), 960).length);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(120);
      expect(Math.min(...sizes)).toBeGreaterThan(0);
    } finally { codec.delete?.(); }
  });
});
