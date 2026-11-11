import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
// covers: devices.handoff, devices.enroll

/**
 * One change of the device set at a time, both ways. An Add or a move of the set keeps the profile here (the giver asks
 * `deviceSetChanging` before it answers a pull or makes a push): a move during an Add would cancel it, and the note of
 * the grant it sent stays on the device that is no longer active, so the set never moves to a new secret. And an Add
 * waits for a move of the set, as a move waits for an Add.
 */
type Inner = {
  enrollment: { current(): { step: string } } | null;
  settingMove: Promise<unknown> | null;
  settings: { online?: boolean };
  deviceSetChanging(): boolean;
  enrollAllowed(): void;
};

const node = () => new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false }) as unknown as Inner;

it.each(["waiting", "confirm", "adding"])("an Add at %s keeps the profile here", (step) => {
  const n = node();
  n.enrollment = { current: () => ({ step }) };
  expect(n.deviceSetChanging()).toBe(true);
});

it.each(["done", "failed"])("an Add that is over (%s) does not", (step) => {
  const n = node();
  n.enrollment = { current: () => ({ step }) };
  expect(n.deviceSetChanging()).toBe(false);
});

it("a move of the set keeps the profile here", () => {
  const n = node();
  expect(n.deviceSetChanging()).toBe(false);
  n.settingMove = new Promise(() => {});
  expect(n.deviceSetChanging()).toBe(true);
});

it("an Add waits for a move of the set", () => {
  const n = node();
  n.settings = { ...n.settings, online: true };
  expect(() => n.enrollAllowed()).not.toThrow();
  n.settingMove = new Promise(() => {});
  expect(() => n.enrollAllowed()).toThrow(/^enroll-busy:/);
});
