import { getPrefix } from "./storage";

/*
 * Which microphone, camera and speaker this profile uses, on this device. A device is kept by its `deviceId`, with
 * its name beside it: the name says which one is missing when it is unplugged, and finds it again when a browser
 * gave it a new id. Nothing chosen (or a device that is gone) is the system's default. Never synced, never sent.
 */

export type DeviceKind = "audioinput" | "videoinput" | "audiooutput";
export const DEVICE_KINDS: readonly DeviceKind[] = ["audioinput", "videoinput", "audiooutput"];

export interface ChosenDevice { id: string; label: string }
export type DeviceChoices = Partial<Record<DeviceKind, ChosenDevice>>;

/** A device as the pickers list it. */
export interface Device { id: string; label: string }

/** Sent on this page when a choice changes (another page of the app sees `storage`). */
export const DEVICES_EVENT = "media-devices-updated";

const key = () => `${getPrefix()}media_devices`;

export function loadDeviceChoices(): DeviceChoices {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key()) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const choices: DeviceChoices = {};
    for (const kind of DEVICE_KINDS) {
      const entry = (parsed as Record<string, unknown>)[kind] as Partial<ChosenDevice> | undefined;
      if (entry && typeof entry.id === "string" && entry.id && typeof entry.label === "string") choices[kind] = { id: entry.id, label: entry.label };
    }
    return choices;
  } catch {
    return {};
  }
}

/** Remembers `device` for `kind`, or the system's default for null. */
export function chooseDevice(kind: DeviceKind, device: ChosenDevice | null): void {
  const choices = loadDeviceChoices();
  if (device?.id) choices[kind] = { id: device.id, label: device.label };
  else delete choices[kind];
  try { localStorage.setItem(key(), JSON.stringify(choices)); } catch { /* chosen for now, not remembered */ }
  window.dispatchEvent(new Event(DEVICES_EVENT));
}

/** The ids browsers give their own "follow the system" entries, which the default option already is. */
const PSEUDO = new Set(["default", "communications"]);

/**
 * Where the devices come from when not the page's own `navigator.mediaDevices`: Ghostly Desktop on Linux, whose
 * calls capture and play in Rust (src/desktop/nativeCalls.ts). A device's id there is its name.
 */
export interface DeviceSource {
  list(): Promise<DeviceList>;
  /** Calls `changed` at each plug and unplug; returns what stops it. */
  watch(changed: () => void): () => void;
  /** Captures as `getUserMedia` does, from these devices (the camera's preview in Settings). */
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Plays the call on this speaker (undefined: the default). The page's own sounds are not the source's. */
  playCallOn(id: string | undefined): void;
  /**
   * Settings' meter on the microphone `id` (undefined: the default), where the page cannot hear it: `level` gets
   * its loudness, 0 to 1. Resolves to what stops it; rejects when the microphone would not open.
   */
  meter?(id: string | undefined, level: (level: number) => void): Promise<() => void>;
  /** Settings' test sound on the speaker `id` (undefined: the default), where the page cannot play there. */
  testSpeaker?(id: string | undefined): Promise<void>;
}

let source: DeviceSource | null = null;

export function setDeviceSource(next: DeviceSource | null): void {
  source = next;
}

export const deviceSource = (): DeviceSource | null => source;

export const hasMediaDevices = () => !!source || (typeof navigator !== "undefined" && typeof navigator.mediaDevices?.enumerateDevices === "function");

/** Whether this engine can send sound to a chosen speaker (Chromium does; Safari and older WebKit may not). */
export const canPickSpeaker = () => !!source || (typeof HTMLMediaElement !== "undefined" && typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === "function");

/** Calls `changed` whenever a device is plugged in or out; returns what stops it. */
export function watchDevices(changed: () => void): () => void {
  if (source) return source.watch(changed);
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  media?.addEventListener?.("devicechange", changed);
  return () => media?.removeEventListener?.("devicechange", changed);
}

export interface DeviceList {
  audioinput: Device[];
  videoinput: Device[];
  audiooutput: Device[];
  /** The name the browser gives the default of each kind ("Default - MacBook Pro Microphone"), when it says. */
  defaults: Partial<Record<DeviceKind, string>>;
  /** The browser named them: the page may use the microphone or camera. Before that, ids and names are empty. */
  named: boolean;
}

export const EMPTY_DEVICES: DeviceList = { audioinput: [], videoinput: [], audiooutput: [], defaults: {}, named: false };

/** What the browser has, per kind, the default entries left out. */
export function groupDevices(infos: readonly MediaDeviceInfo[]): DeviceList {
  const list: DeviceList = { audioinput: [], videoinput: [], audiooutput: [], defaults: {}, named: infos.some((d) => !!d.label) };
  for (const info of infos) {
    const kind = info.kind as DeviceKind;
    if (!DEVICE_KINDS.includes(kind)) continue;
    if (PSEUDO.has(info.deviceId)) {
      if (info.deviceId === "default" && info.label) list.defaults[kind] = info.label;
      continue;
    }
    // Without permission there is one nameless entry per kind: nothing to pick yet.
    if (!info.deviceId) continue;
    if (!list[kind].some((d) => d.id === info.deviceId)) list[kind].push({ id: info.deviceId, label: info.label });
  }
  return list;
}

export async function listDevices(): Promise<DeviceList> {
  if (!hasMediaDevices()) return EMPTY_DEVICES;
  try {
    return source ? await source.list() : groupDevices(await navigator.mediaDevices.enumerateDevices());
  } catch {
    return EMPTY_DEVICES;
  }
}

/**
 * The device `kind` uses now: the chosen one when the browser lists it (by id, or else by name), else the default
 * (`id` undefined), with `missing` naming the chosen one that is not there. When the browser has not named its
 * devices yet it cannot tell: the choice is used as a preference.
 */
export function resolveDevice(kind: DeviceKind, list: DeviceList, choices: DeviceChoices = loadDeviceChoices()): { id?: string; missing?: string } {
  const chosen = choices[kind];
  if (!chosen) return {};
  if (!list.named) return { id: chosen.id };
  const devices = list[kind];
  if (devices.some((d) => d.id === chosen.id)) return { id: chosen.id };
  const renamed = chosen.label ? devices.find((d) => d.label === chosen.label) : undefined;
  if (renamed) return { id: renamed.id };
  return { missing: chosen.label || chosen.id };
}

/**
 * The `deviceId` constraint for what `kind` should capture from, or undefined for the default. `ideal`: a chosen
 * device that is gone gives the default, never an error; whoever asked can compare the track's `deviceId`.
 */
export function preferredDevice(kind: "audioinput" | "videoinput", choices: DeviceChoices = loadDeviceChoices()): ConstrainDOMString | undefined {
  const id = choices[kind]?.id;
  return id ? { ideal: id } : undefined;
}

/** The device a live track captures from, where the engine says. */
export function trackDevice(track: MediaStreamTrack | undefined): string | undefined {
  try {
    return track?.getSettings?.().deviceId || undefined;
  } catch {
    return undefined;
  }
}

/** What can play on a chosen speaker: a media element, or an `AudioContext` (Chromium 110+). */
type SinkTarget = { setSinkId?: (id: string) => Promise<void>; sinkId?: unknown };

/** Sends `element`'s sound to the speaker `id` ("" the default). Engines without speaker choice keep the default. */
export async function applySpeaker(element: HTMLMediaElement | AudioContext | null, id: string | undefined): Promise<void> {
  const target = element as SinkTarget | null;
  if (typeof target?.setSinkId !== "function") return;
  const next = id ?? "";
  if (typeof target.sinkId === "string" ? target.sinkId === next : !target.sinkId && !next) return;
  await target.setSinkId(next);
}

/**
 * The speaker this profile chose, as the browser knows it now (a new id is found by its name), or undefined for
 * the default: nothing chosen, the chosen one unplugged, or an engine that cannot choose.
 */
export async function chosenSpeaker(): Promise<string | undefined> {
  if (!loadDeviceChoices().audiooutput || !canPickSpeaker()) return undefined;
  return resolveDevice("audiooutput", await listDevices()).id;
}

/** Sends `target`'s sound to the chosen speaker, once. Never fails: see `followSpeaker`. */
export function toChosenSpeaker(target: HTMLMediaElement | AudioContext, live: () => boolean = () => true): Promise<void> {
  return chosenSpeaker()
    .then((id) => (live() ? applySpeaker(target, id) : undefined))
    .catch(() => (live() ? applySpeaker(target, undefined).catch(() => {}) : undefined));
}

const isDeviceChoice = (event: Event) => !(event instanceof StorageEvent) || event.key === null || event.key === key();

/**
 * Plays `target` on the chosen speaker, now and whenever the choice changes (in Settings, a call's menu or another
 * page of the app), until `stop`. `ready` settles once the first choice is applied. Never fails: a speaker the
 * engine refuses (Chromium, before the page may use the microphone) or that is gone leaves the default.
 */
export function followSpeaker(target: HTMLMediaElement | AudioContext): { ready: Promise<void>; stop: () => void } {
  if (typeof (target as SinkTarget).setSinkId !== "function") return { ready: Promise.resolve(), stop: () => {} };
  let live = true;
  const apply = () => toChosenSpeaker(target, () => live);
  const changed = (event: Event) => { if (isDeviceChoice(event)) void apply(); };
  window.addEventListener(DEVICES_EVENT, changed);
  window.addEventListener("storage", changed);
  return {
    ready: apply(),
    stop: () => {
      live = false;
      window.removeEventListener(DEVICES_EVENT, changed);
      window.removeEventListener("storage", changed);
    },
  };
}
