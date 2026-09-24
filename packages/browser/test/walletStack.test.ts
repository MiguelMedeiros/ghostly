import { describe, expect, it } from 'vitest';
import { stackLayout, stackStrips, stepCard, stripAt } from '../../../src/components/walletStack';

describe('the wallet stack', () => {
  it('keeps every card in its own place, inside the deck', () => {
    for (const width of [320, 480, 700, 960]) {
      const layout = stackLayout(width, 6);
      expect(layout.lefts[0]).toBeGreaterThanOrEqual(8);
      expect(layout.lefts[5] + layout.width).toBeLessThanOrEqual(width - 8 + 0.001);
      expect(layout.step).toBeGreaterThan(0);
      expect(layout.step).toBeLessThanOrEqual(layout.width * 0.42);
      expect(layout.height).toBe(Math.round(layout.width / 1.586));
    }
    // A wide column keeps the cards together, centred, instead of spreading them to the edges.
    const wide = stackLayout(1600, 6);
    expect(wide.width).toBe(340);
    expect(wide.lefts[0] - 0).toBeCloseTo(1600 - (wide.lefts[5] + wide.width), 6);
  });

  it('tiles the row with the strips that show, whichever card is on top', () => {
    const layout = stackLayout(700, 6);
    for (let active = 0; active < 6; active++) {
      const strips = stackStrips(layout, active);
      expect(strips[active].left).toBeCloseTo(layout.lefts[active], 6);
      expect(strips[active].right).toBeCloseTo(layout.lefts[active] + layout.width, 6);
      for (let i = 1; i < 6; i++) expect(strips[i].left).toBe(strips[i - 1].right);
      expect(strips[0].left).toBe(layout.lefts[0]);
      expect(strips[5].right).toBeCloseTo(layout.lefts[5] + layout.width, 6);
      // Before the chosen card a card shows its leading edge; after it, its trailing edge.
      if (active > 0) expect(strips[0].right).toBeCloseTo(layout.lefts[0] + layout.step, 6);
      if (active < 5) expect(strips[5].right).toBeCloseTo(layout.lefts[5] + layout.width, 6);
    }
  });

  it('brings up the card under the pointer, and keeps it there once up', () => {
    const layout = stackLayout(700, 6);
    for (let active = 0; active < 6; active++) {
      const strips = stackStrips(layout, active);
      for (let target = 0; target < 6; target++) {
        const { left, right } = strips[target];
        for (const x of [left, (left + right) / 2, right - 0.5]) {
          expect(stripAt(strips, x)).toBe(target);
          // Once that card is on top, the pointer that brought it up is still on it: no flicker.
          expect(stripAt(stackStrips(layout, target), x)).toBe(target);
        }
      }
    }
    expect(stripAt(stackStrips(layout, 0), 0)).toBe(-1);
    expect(stripAt(stackStrips(layout, 0), 699)).toBe(-1);
  });

  it('goes round at the ends', () => {
    expect(stepCard(0, -1, 6)).toBe(5);
    expect(stepCard(5, 1, 6)).toBe(0);
    expect(stepCard(2, 1, 6)).toBe(3);
    expect(stepCard(0, 1, 0)).toBe(0);
  });

  it('gives a single card the whole room', () => {
    const one = stackLayout(300, 1, { max: 250 });
    expect(one.width).toBe(250);
    expect(one.step).toBe(0);
    expect(stackStrips(one, 0)).toEqual([{ left: 25, right: 275 }]);
  });
});
