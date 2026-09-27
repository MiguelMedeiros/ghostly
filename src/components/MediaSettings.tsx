import { useEffect, useRef, useState, type ReactNode } from "react";
import { voiceLevel } from "@ghostly/core";
import { useI18n } from "../contexts/I18nContext";
import { useMediaDevices } from "../hooks/useMediaDevices";
import { applySpeaker, canPickSpeaker, chooseDevice, resolveDevice, type DeviceKind, type DeviceList } from "../lib/mediaDevices";
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
  if (!supported) return null;

  const speaker = canPickSpeaker() && list.audiooutput.length > 0;
  return (
    <Section title={t("settings.media.title")} testId="settings-media">
      {!list.named && (
        <Row label={t("settings.media.names")} hint={t("settings.media.namesHint")} testId="settings-media-names">
          <Button data-testid="settings-media-allow" onClick={() => void allowNames()}>{t("settings.media.allow")}</Button>
        </Row>
      )}
      <DeviceRow kind="audioinput" list={list} choices={choices} info={t("settings.media.microphoneInfo")}>
        {(id, fail) => <MicrophoneTest id={id} fail={fail} />}
      </DeviceRow>
      <DeviceRow kind="videoinput" list={list} choices={choices} info={t("settings.media.cameraInfo")}>
        {(id, fail) => <CameraTest id={id} fail={fail} />}
      </DeviceRow>
      {speaker && (
        <DeviceRow kind="audiooutput" list={list} choices={choices} info={t("settings.media.speakerInfo")}>
          {(id, fail) => <SpeakerTest id={id} fail={fail} />}
        </DeviceRow>
      )}
    </Section>
  );
}

function DeviceRow({ kind, list, choices, info, children }: {
  kind: DeviceKind;
  list: DeviceList;
  choices: ReturnType<typeof useMediaDevices>["choices"];
  info: string;
  /** The row's way to try the device; `fail` says it could not be opened. */
  children: (id: string | undefined, fail: (failed: boolean) => void) => ReactNode;
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
    <Row label={name} info={info} testId={`${TEST_ID[kind]}-row`}
      hint={missing ? <span role="status" data-testid={`${TEST_ID[kind]}-missing`}>{t("settings.media.missing", { name: missing })}</span>
        : failed ? <span role="alert" data-testid={`${TEST_ID[kind]}-failed`} className="text-danger">{t("settings.media.failed")}</span> : undefined}>
      <Select fit aria-label={name} data-testid={TEST_ID[kind]} value={id ?? ""} options={options} onChange={pick} />
      {children(id, setFailed)}
    </Row>
  );
}

/** A level meter on the chosen microphone, while it is on. */
function MicrophoneTest({ id, fail }: { id: string | undefined; fail: (failed: boolean) => void }) {
  const { t } = useI18n();
  const [on, setOn] = useState(false);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!on) return;
    let live = true;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    fail(false);
    navigator.mediaDevices.getUserMedia({ audio: from(id) }).then((s) => {
      if (!live) { s.getTracks().forEach((track) => track.stop()); return; }
      stream = s;
      try {
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(s).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        timer = setInterval(() => {
          analyser.getFloatTimeDomainData(samples);
          setLevel(voiceLevel(samples));
        }, 80);
      } catch {
        // No meter in this engine: the microphone still opened.
      }
    }, () => { if (live) { fail(true); setOn(false); } });
    return () => {
      live = false;
      clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
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

/** The chosen camera's picture, while it is on. */
function CameraTest({ id, fail }: { id: string | undefined; fail: (failed: boolean) => void }) {
  const { t } = useI18n();
  const [on, setOn] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!on) return;
    let live = true;
    let stream: MediaStream | null = null;
    fail(false);
    navigator.mediaDevices.getUserMedia({ video: from(id), audio: false }).then((s) => {
      if (!live) { s.getTracks().forEach((track) => track.stop()); return; }
      stream = s;
      if (video.current) { video.current.srcObject = s; void video.current.play?.()?.catch(() => {}); }
    }, () => { if (live) { fail(true); setOn(false); } });
    return () => {
      live = false;
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [on, id, fail]);

  return <>
    <Button data-testid="settings-camera-preview" aria-pressed={on} onClick={() => setOn(!on)}>
      {on ? t("settings.media.stop") : t("settings.media.preview")}
    </Button>
    {on && (
      <video ref={video} muted playsInline aria-label={t("settings.media.previewLabel")} data-testid="settings-camera-video"
        className="basis-full w-full max-w-xs aspect-video rounded-lg bg-black object-cover -scale-x-100" />
    )}
  </>;
}

/** A short sound on the chosen speaker. */
function SpeakerTest({ id, fail }: { id: string | undefined; fail: (failed: boolean) => void }) {
  const { t } = useI18n();
  const play = async () => {
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
