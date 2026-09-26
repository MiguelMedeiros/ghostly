// The film page. render.mjs opens it, calls `window.seek(t)` and takes a screenshot for every frame; `?t=40` shows
// one moment in a browser.
import "./film.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Film, FORMATS, SOUNDS, type Format } from "./Film";

declare global {
  interface Window { seek: (t: number) => Promise<void>; ready: boolean; sounds: typeof SOUNDS }
}

const params = new URLSearchParams(location.search);
const format = (params.get("format") ?? "16x9") as Format;
let setTime: (t: number) => void = () => {};
function App() {
  const [t, setT] = useState(Number(params.get("t") ?? 0));
  setTime = setT;
  return <Film t={t} format={format} />;
}
const [width, height] = FORMATS[format];
document.documentElement.style.setProperty("--film-w", `${width}px`);
document.documentElement.style.setProperty("--film-h", `${height}px`);
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
window.seek = async (t: number) => {
  flushSync(() => setTime(t));
  await frame();
};
await document.fonts.ready;
await window.seek(Number(params.get("t") ?? 0));
window.sounds = SOUNDS;
window.ready = true;
