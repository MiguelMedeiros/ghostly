import { useEffect, useRef, useState, type ReactNode } from "react";
import { voiceLevel } from "@ghostly/core";
import { useI18n } from "../contexts/I18nContext";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { applySpeaker, canPickSpeaker, chooseDevice, deviceSource, resolveDevice, type DeviceKind, type DeviceList } from "../lib/mediaDevices";
import { soundUrl } from "../lib/sounds";
import { Row, Section } from "./layout";
import { Select, type SelectOption } from "./ui/Select";
import { Button } from "./wallet/ui";

const NAME_KEY = { audioinput: "settings.media.microphone", videoinput: "settings.media.camera", audiooutput: "settings.media.speaker" } as const;
const TEST_ID = { audioinput: "settings-microphone", videoinput: "settings-camera", audiooutput: "settings-speaker" } as const;

/** The constraint for capturing from `id`: that device exactly, or the default. */
const from = (id: string | undefined): MediaTrackConstraints | true => (id ? { deviceId: { exact: id } } : true);

/**
 * Settings → Audio & video: which microphone, camera and speaker this profile uses, each with a way to try it.
 * Nothing is asked of the browser until a button is pressed: the level meter, the preview and the device names
 * each wait for one.
 */
export function MediaSettings() {
  const { t } = useI18n();
  const { supported, list, choices, allowNames } = useMediaDevices();
  const [preview, setPreview] = useState(false);
  if (!supported) return null;

  // Where a speaker can be picked, its row is there from the start, "System default" until the list arrives, as the
  // microphone's and the camera's are: a row that came with the list would push everything under it down.
  const speaker = canPickSpeaker();
  // Where calls capture and play outside the page (Linux Desktop), the page cannot hear that microphone or play on
  // that speaker: they are tried where the calls run, when that can.
  const source = deviceSource();
  const hears = !source || !!source.meter;
  const plays = !source || !!source.testSpeaker;
  return (
    <Section title={t("settings.media.title")} testId="settings-media">
      {/* Names are the page's own browser's to give. A device source names its devices itself: no row that shows
          while its list is on the way and then goes, moving everything under it. */}
      {!source && !list.named && (
        <Row label={t("settings.media.names")} hint={t("settings.media.namesHint")} testId="settings-media-names">
          <Button data-testid="settings-media-allow" onClick={() => void allowNames()}>{t("settings.media.allow")}</Button>
        </Row>
      )}
      <DeviceRow kind="audioinput" list={list} choices={choices} info={t("settings.media.microphoneInfo")}>
        {(id, fail) => hears && <MicrophoneTest id={id} fail={fail} />}
      </DeviceRow>
      <DeviceRow kind="videoinput" list={list} choices={choices} info={t("settings.media.cameraInfo")}
        below={preview ? (id, fail) => <CameraPreview id={id} fail={(failed) => { fail(failed); if (failed) setPreview(false); }} /> : undefined}>
        {() => (
          <Button data-testid="settings-camera-preview" aria-pressed={preview} onClick={() => setPreview(!preview)}>
            {preview ? t("settings.media.stop") : t("settings.media.preview")}
          </Button>
        )}
      </DeviceRow>
      {speaker && (
        <DeviceRow kind="audiooutput" list={list} choices={choices} info={t("settings.media.speakerInfo")}>
          {(id, fail) => plays && <SpeakerTest id={id} fail={fail} />}
        </DeviceRow>
      )}
    </Section>
  );
}

function DeviceRow({ kind, list, choices, info, children, below }: {
  kind: DeviceKind;
  list: DeviceList;
  choices: ReturnType<typeof useMediaDevices>["choices"];
  info: string;
  /** The row's way to try the device; `fail` says it could not be opened. */
  children: (id: string | undefined, fail: (failed: boolean) => void) => ReactNode;
  /** What trying it shows under the row, the whole width (the camera's picture). */
  below?: (id: string | undefined, fail: (failed: boolean) => void) => ReactNode;
}) {
  const { t } = useI18n();
  const name = t(NAME_KEY[kind]);
  const { id, missing } = resolveDevice(kind, list, choices);
  const [failed, setFailed] = useState(false);
  const chosen = choices[kind];
  const options: SelectOption[] = [
    { value: "", label: t("settings.media.systemDefault"), description: list.defaults[kind] },
    ...list[kind].map((device, i) => ({ value: device.id, label: device.label || `${name} ${i + 1}` })),
  ];
  // Before the browser names its devices, a choice made earlier is still shown as chosen.
  if (id && !options.some((o) => o.value === id) && chosen) options.push({ value: chosen.id, label: chosen.label || name });

  const pick = (value: string) => {
    const device = list[kind].find((d) => d.id === value);
    chooseDevice(kind, value ? { id: value, label: device?.label ?? chosen?.label ?? "" } : null);
  };

  return (
    <div>
      <Row label={name} info={info} testId={`${TEST_ID[kind]}-row`}
        hint={missing ? <span role="status" data-testid={`${TEST_ID[kind]}-missing`}>{t("settings.media.missing", { name: missing })}</span>
          : failed ? <span role="alert" data-testid={`${TEST_ID[kind]}-failed`} className="text-danger">{t("settings.media.failed")}</span> : undefined}>
        <Select fit aria-label={name} data-testid={TEST_ID[kind]} value={id ?? ""} options={options} onChange={pick} />
        {children(id, setFailed)}
      </Row>
      {below && <div className="px-4 pb-3.5">{below(id, setFailed)}</div>}
    </div>
  );
}

/** Listens to the page's own microphone `id`: `level` gets its loudness every 80 ms. Resolves to what stops it. */
async function pageMeter(id: string | undefined, level: (level: number) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: from(id) });
  let context: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      level(voiceLevel(samples));
    }, 80);
  } catch {
    // No meter in this engine: the microphone still opened.
  }
  return () => {
    clearInterval(timer);
    stream.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => {});
  };
}

/** A level meter on the chosen microphone, while it is on: the page's own, or the device source's. */
function MicrophoneTest({ id, fail }: { id: string | undefined; fail: (failed: boolean) => void }) {
  const { t } = useI18n();
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!on) return;
    let live = true;
    let stop: (() => void) | undefined;
    fail(false);
    const source = deviceSource();
    const listen = source?.meter ? source.meter.bind(source) : pageMeter;
    listen(id, (next) => { if (live) setLevel(next); }).then((stopping) => {
      if (live) stop = stopping;
      else stopping();
    }, () => { if (live) { fail(true); setOn(false); } });
    return () => {
      live = false;
      stop?.();
      setLevel(0);
    };
  }, [on, id, fail]);

  return <>
    {on && (
      <div role="meter" aria-label={t("settings.media.level")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}
        data-testid="settings-microphone-level" className="w-20 h-2 rounded-full bg-surface-alt overflow-hidden">
        <div className="h-full bg-accent transition-[width] duration-75" style={{ width: `${Math.round(level * 100)}%` }} />
      </div>
    )}
    <Button data-testid="settings-microphone-test" aria-pressed={on} onClick={() => setOn(!on)}>
      {on ? t("settings.media.stop") : t("settings.media.test")}
    </Button>
  </>;
}

/** The chosen camera's picture, while it is shown. */
function CameraPreview({ id, fail }: { id: string | undefined; fail: (failed: boolean) => void }) {
  const { t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const failRef = useRef(fail);
  failRef.current = fail;

  useEffect(() => {
    let live = true;
    let stream: MediaStream | null = null;
    failRef.current(false);
    const capture = deviceSource()?.getUserMedia ?? ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
    capture({ video: from(id), audio: false }).then((s) => {
      if (!live) { s.getTracks().forEach((track) => track.stop()); return; }
      stream = s;
      if (video.current) { video.current.srcObject = s; void video.current.play?.()?.catch(() => {}); }
    }, () => { if (live) failRef.current(true); });
    return () => {
      live = false;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [id]);

  return (
    <video ref={video} muted playsInline aria-label={t("settings.media.previewLabel")} data-testid="settings-camera-video"
      className="w-full max-w-sm aspect-video rounded-lg bg-black object-cover -scale-x-100" />
  );
}

/** A short sound on the chosen speaker: the page's own, or the device source's. */
function SpeakerTest({ id, fail }: { id: string | undefined; fail: (failed: boolean) => void }) {
  const { t } = useI18n();
  const play = async () => {
    const source = deviceSource();
    if (source?.testSpeaker) {
      try {
        await source.testSpeaker(id);
        fail(false);
      } catch {
        fail(true);
      }
      return;
    }
    const url = soundUrl("connected");
    if (!url) return;
    const audio = new Audio(url);
    try {
      await applySpeaker(audio, id);
      await audio.play();
      fail(false);
    } catch {
      fail(true);
    }
  };
  return (
    <Button data-testid="settings-speaker-test" onClick={() => void play()}>
      {t("settings.media.testSound")}
    </Button>
  );
}
