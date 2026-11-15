import os
os.environ["WEBKIT_DISABLE_COMPOSITING_MODE"] = "1"
os.environ["LIBGL_ALWAYS_SOFTWARE"] = "1"
os.environ["GDK_BACKEND"] = "x11"
os.environ.pop("WAYLAND_DISPLAY", None)
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib

JS = "JSON.stringify({ua: navigator.userAgent, rtc: 'RTCPeerConnection' in window, gum: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)})"

def run(webrtc):
    view = WebKit2.WebView()
    s = view.get_settings()
    s.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
    if webrtc is not None and hasattr(s, "set_enable_webrtc"):
        s.set_enable_webrtc(webrtc)
    out = {}
    def done(v, res, _):
        out["r"] = v.evaluate_javascript_finish(res).to_string()
        Gtk.main_quit()
    def loaded(v, ev):
        if ev == WebKit2.LoadEvent.FINISHED:
            v.evaluate_javascript(JS, -1, None, None, None, done, None)
    view.connect("load-changed", loaded)
    w = Gtk.Window()
    w.add(view)
    w.show_all()
    view.load_html("<p>x</p>", "http://probe.localhost/")
    GLib.timeout_add_seconds(15, Gtk.main_quit)
    Gtk.main()
    w.destroy()
    print("webrtc setting", webrtc, "version", WebKit2.get_major_version(), WebKit2.get_minor_version(), out.get("r"))

run(None)
run(True)
