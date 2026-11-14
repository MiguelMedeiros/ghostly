import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceRecorder } from "../../lib/voiceRecorder";
import { installFakeMedia, media, removeFakeMedia } from "./fakeMedia";

// covers: files.voice.record

const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  installFakeMedia();
});

afterEach(() => {
  vi.useRealTimers();
  removeFakeMedia();
});

/** The device's clock is set by hand, or stepped by NTP: the wall clock jumps, time itself does not. */
function clockJumps(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

async function recording() {
  const recorder = new VoiceRecorder();
  const onLimit = vi.fn();
  recorder.onLimit = onLimit;
  await recorder.start();
  return { recorder, onLimit };
}

describe("a voice recording while the device's clock changes", () => {
  it("set 15 minutes ahead, it keeps recording: the limit is not reached and the length is what was recorded", async () => {
    const { recorder, onLimit } = await recording();
    await vi.advanceTimersByTimeAsync(3_000);
    clockJumps(15 * MINUTE);
    await vi.advanceTimersByTimeAsync(300);
    expect(onLimit).not.toHaveBeenCalled();
    expect(recorder.recording).toBe(true);
    await vi.advanceTimersByTimeAsync(1_700);
    expect(recorder.elapsed()).toBe(5_000);
    const result = await recorder.stop();
    expect(result?.voice.duration).toBe(5_000);
  });

  it("set 10 minutes back, the recording is kept with the length that was recorded", async () => {
    const { recorder } = await recording();
    await vi.advanceTimersByTimeAsync(5_000);
    clockJumps(-10 * MINUTE);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recorder.elapsed()).toBe(6_000);
    const result = await recorder.stop();
    expect(result).not.toBeNull();
    expect(result?.voice.duration).toBe(6_000);
  });

  it("a jump across a pause and a resume leaves the time recorded as it was", async () => {
    const { recorder } = await recording();
    await vi.advanceTimersByTimeAsync(4_000);
    clockJumps(-10 * MINUTE);
    recorder.pause();
    await vi.advanceTimersByTimeAsync(2_000);
    recorder.resume();
    clockJumps(15 * MINUTE);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(recorder.elapsed()).toBe(7_000);
    expect((await recorder.stop())?.voice.duration).toBe(7_000);
  });

  it("the microphone ending after a jump keeps the time recorded until then", async () => {
    const { recorder } = await recording();
    const onEnded = vi.fn();
    recorder.onEnded = onEnded;
    await vi.advanceTimersByTimeAsync(8_000);
    clockJumps(-10 * MINUTE);
    await vi.advanceTimersByTimeAsync(2_000);
    media.tracks[0].readyState = "ended";
    media.recorders[0].stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(recorder.elapsed()).toBe(10_000);
    expect((await recorder.stop())?.voice.duration).toBe(10_000);
  });

  it("still pauses at the 15-minute limit when 15 minutes are recorded", async () => {
    const { recorder, onLimit } = await recording();
    await vi.advanceTimersByTimeAsync(15 * MINUTE + 200);
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(recorder.paused).toBe(true);
    expect((await recorder.stop())?.voice.duration).toBe(15 * MINUTE);
  });
});
