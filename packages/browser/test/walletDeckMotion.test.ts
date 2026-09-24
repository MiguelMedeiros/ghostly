import { describe, expect, it } from 'vitest';
import { ghostFrames, incomingFrames, outgoingFrames, sheenFrames, switchDirection } from '../../../src/components/walletDeckMotion';
// covers: wallet.deck

const at = (frames: Keyframe[], i: number) => frames[i < 0 ? frames.length + i : i] as Record<string, unknown>;

describe('the wallet deck switch', () => {
  it('knows which way the chosen card moved', () => {
    expect(switchDirection(0, 3)).toBe(1);
    expect(switchDirection(4, 1)).toBe(-1);
    // Going round the end moves back along the deck, which is where the card is.
    expect(switchDirection(5, 0)).toBe(-1);
    expect(switchDirection(2, 2)).toBe(0);
    expect(switchDirection(-1, 2)).toBe(0);
  });

  it('starts and ends every added swing at rest, so an interrupted one never makes a card jump', () => {
    for (const dir of [-1, 0, 1] as const) {
      for (const frames of [incomingFrames(dir), outgoingFrames(dir)]) {
        for (const edge of [at(frames, 0), at(frames, -1)]) {
          expect(edge.translate).toBe('0px 0px');
          expect(edge.rotate).toBe('0deg');
        }
        // Only what moves on the compositor.
        for (const frame of frames) for (const key of Object.keys(frame)) expect(['translate', 'rotate', 'offset', 'easing']).toContain(key);
      }
    }
  });

  it('leans the way the deck moved: a step back mirrors a step forward', () => {
    const tilt = (frames: Keyframe[]) => frames.map((f) => Number.parseFloat(String((f as Record<string, unknown>).rotate)));
    expect(tilt(incomingFrames(-1))).toEqual(tilt(incomingFrames(1)).map((n) => -n || 0));
    expect(tilt(outgoingFrames(-1))).toEqual(tilt(outgoingFrames(1)).map((n) => -n || 0));
    expect(at(sheenFrames(1), 0).translate).toBe('-120% 0px');
    expect(at(sheenFrames(-1), 0).translate).toBe('120% 0px');
  });

  it("brings the ghost from hidden to the card's own look", () => {
    const frames = ghostFrames(1, 0.3);
    expect(at(frames, 0).opacity).toBe(0);
    expect(at(frames, -1)).toMatchObject({ opacity: 0.3, translate: '0px 0px', scale: '1', rotate: '0deg' });
  });
});
