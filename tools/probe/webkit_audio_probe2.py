#!/usr/bin/env python3
"""r11k probe v2: where WebKitGTK's page waits in Web Audio and <audio>, mode by mode, each in a fresh process.
No network, no files besides this script; quiet 80 ms tones. Run with no argument: every mode in turn (~3 min).
  python3 webkit_audio_probe2.py            # all modes
  python3 webkit_audio_probe2.py close-new  # one mode
Needs python-gobject and webkit2gtk-4.1.
"""
import gi, os, subprocess, sys, time
MODES = ["close-new", "close-new-nowait", "element", "running", "suspend-long"]

if len(sys.argv) < 2:
    for mode in MODES:
        print(f"===== {mode}", flush=True)
        try:
            subprocess.run([sys.executable, __file__, mode], timeout=60)
        except subprocess.TimeoutExpired:
            print("  (process killed after 60 s)", flush=True)
    sys.exit(0)

MODE = sys.argv[1]
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib

PAGE = r"""<!doctype html><meta charset=utf-8><body><script>
const MODE = "@MODE@";
const log = (s) => window.webkit.messageHandlers.r11k.postMessage(String(s));
let last = Date.now(), longest = 0;
setInterval(() => { const n = Date.now(); longest = Math.max(longest, n - last); last = n; }, 50);
let beat = 0; setInterval(() => log("heartbeat " + (++beat)), 2000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const gap = () => { const g = longest; longest = 0; last = Date.now(); return g; };
async function T(label, fn) { log(label + " start"); const t = Date.now(); let v; try { v = fn(); } catch (e) { log(label + " threw " + e); return; } const sync = Date.now() - t; log(label + " returned sync=" + sync + "ms"); try { await v; } catch (e) { log(label + " rejected " + e); } log(label + " done total=" + (Date.now() - t) + "ms"); return v; }
function tone(ctx) { const o = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = 0.03; o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.08); }
function wav() {
  const rate = 22050, n = Math.floor(rate * 0.15), b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); s(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, "data"); v.setUint32(40, n * 2, true);
  for (let k = 0; k < n; k++) v.setInt16(44 + k * 2, Math.sin(2 * Math.PI * 880 * k / rate) * 2000, true);
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}
async function run() {
  if (MODE === "close-new" || MODE === "close-new-nowait") {
    for (let i = 1; i <= 3; i++) {
      gap();
      const ctx = await T("new AudioContext " + i, () => new AudioContext());
      log("state " + ctx.state);
      await T("resume " + i, () => ctx.resume()); tone(ctx); await wait(300);
      await T("close " + i, () => ctx.close());
      if (MODE === "close-new") { log("waiting 1500 ms"); await wait(1500); log("waited"); }
      log("longest page gap " + gap() + "ms");
    }
  } else if (MODE === "element") {
    const url = wav();
    for (let i = 1; i <= 3; i++) {
      gap();
      const a = await T("new Audio " + i, () => new Audio(url));
      await T("play " + i, () => a.play());
      await new Promise((r) => { a.onended = () => { log("ended " + i); r(); }; setTimeout(r, 3000); });
      await wait(300); log("longest page gap " + gap() + "ms");
      await wait(1500);
    }
    log("cpu-mark element-idle-kept"); await wait(10000); log("cpu-mark end");
  } else if (MODE === "running") {
    const ctx = new AudioContext();
    await T("first resume", () => ctx.resume());
    for (let i = 1; i <= 3; i++) { tone(ctx); await wait(2000); }
    log("longest page gap " + gap() + "ms");
    log("cpu-mark running-idle"); await wait(10000);
    await T("suspend", () => ctx.suspend());
    log("cpu-mark suspended-idle"); await wait(10000); log("cpu-mark end");
    gap(); await T("resume after 10 s suspended", () => ctx.resume()); tone(ctx); await wait(300);
    log("longest page gap " + gap() + "ms");
    await T("close", () => ctx.close());
    log("cpu-mark closed-idle"); await wait(10000); log("cpu-mark end");
  } else if (MODE === "suspend-long") {
    const ctx = new AudioContext();
    await T("first resume", () => ctx.resume()); tone(ctx); await wait(500);
    for (let i = 1; i <= 2; i++) { await T("suspend " + i, () => ctx.suspend()); await wait(6000); gap(); await T("resume after 6 s " + i, () => ctx.resume()); tone(ctx); await wait(300); log("longest page gap " + gap() + "ms"); }
  }
  log("DONE");
}
log("ready webkit " + navigator.userAgent);
run();
</script>"""

def web_ticks():
    total = 0
    for pid in filter(str.isdigit, os.listdir("/proc")):
        try:
            if not open(f"/proc/{pid}/comm").read().startswith("WebKitWebProces"): continue
            f = open(f"/proc/{pid}/stat").read().split(") ")[1].split()
            total += int(f[11]) + int(f[12])
        except Exception: pass
    return total

print(f"  WebKitGTK {WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}", flush=True)
win = Gtk.Window(title="r11k audio probe"); win.set_default_size(300, 120)
manager = WebKit2.UserContentManager(); manager.register_script_message_handler("r11k")
view = WebKit2.WebView.new_with_user_content_manager(manager)
view.get_settings().set_property("media-playback-requires-user-gesture", False)
win.add(view); win.connect("destroy", Gtk.main_quit)
start = time.time()
mark = {"name": None, "ticks": 0, "at": 0.0}

def message(_m, result):
    try: text = result.get_js_value().to_string()
    except AttributeError: text = result.to_string()
    now = time.time()
    if text.startswith("cpu-mark"):
        t = web_ticks()
        if mark["name"]:
            print(f"  {now - start:6.2f}s CPU {mark['name']}: {t - mark['ticks']} ticks in {now - mark['at']:.1f} s", flush=True)
        name = text.split(" ", 1)[1]
        mark.update(name=None if name == "end" else name, ticks=t, at=now)
        return
    print(f"  {now - start:6.2f}s {text}", flush=True)
    if text == "DONE": GLib.timeout_add(200, Gtk.main_quit)
manager.connect("script-message-received::r11k", message)
view.load_html(PAGE.replace("@MODE@", MODE), "http://localhost/")
win.show_all()
GLib.timeout_add(50_000, lambda: (print("  timeout (50 s)", flush=True), Gtk.main_quit()))
Gtk.main()
