import os, json, tempfile, secrets
os.environ["WEBKIT_DISABLE_COMPOSITING_MODE"] = "1"
os.environ["LIBGL_ALWAYS_SOFTWARE"] = "1"
os.environ["GDK_BACKEND"] = "x11"
os.environ.pop("WAYLAND_DISPLAY", None)
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib

DROP = "application/x-ghostly-dropped-files"
tmp = tempfile.mkdtemp(prefix="nonce-probe-")
files = []
for name in ["a.txt", "photo b.jpg", "ç ü.bin"]:
    p = os.path.join(tmp, name)
    with open(p, "w") as f:
        f.write(name)
    files.append(p)

PAGE = f"""<input type=file multiple id=ghostly-dropped-files accept="{DROP}" style="position:fixed;left:-9999px">
<iframe srcdoc="<input type=file id=x accept='{DROP}'>"></iframe>
<script>
const i = document.getElementById('ghostly-dropped-files');
i.addEventListener('change', () => {{ document.title = 'got:' + JSON.stringify([...i.files].map(f => [f.name, f.size])); }});
i.addEventListener('cancel', () => {{ document.title = 'cancel'; }});
</script>"""

def choose_script(accept):
    return "(i=>{if(i){i.accept='" + accept + "';i.click()}})(document.getElementById('ghostly-dropped-files'))"

view = WebKit2.WebView()
view.get_settings().set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.NEVER)
state = {"accept": None, "seen": []}

def chooser(_, request):
    types = list(request.get_mime_types() or [])
    state["seen"].append(types)
    if not (len(types) == 1 and types[0].startswith(DROP)):
        return False
    if types == [state["accept"]]:
        request.select_files(files)
    else:
        request.cancel()
    return True

view.connect("run-file-chooser", chooser)

steps = []
def title(v, _):
    t = v.get_title() or ""
    if t:
        steps.append(t)
        print("title:", t, "chooser types seen:", state["seen"])
        next_step()

def next_step():
    if plan:
        plan.pop(0)()
    else:
        Gtk.main_quit()

def ask(accept_override=None):
    def go():
        state["accept"] = DROP + "." + secrets.token_hex(16)
        view.evaluate_javascript("document.title=''", -1, None, None, None, None, None)
        view.evaluate_javascript(choose_script(accept_override or state["accept"]), -1, None, None, None, None, None)
        GLib.timeout_add(1500, lambda: (print("no title after 1.5 s, chooser types seen:", state["seen"]), next_step(), False)[2] if not steps or steps[-1] == "" else False)
    return go

# 1: the real flow (nonce set, clicked). 2: a stale/wrong type: chooser must be refused (cancel).
plan = [ask(), ask(DROP + "." + "0" * 32)]

def loaded(v, ev):
    if ev == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(300, lambda: (next_step(), False)[1])

view.connect("load-changed", loaded)
view.connect("notify::title", title)
w = Gtk.Window()
w.set_default_size(400, 300)
w.add(view)
w.show_all()
view.load_html(PAGE, "http://probe.localhost/")
GLib.timeout_add_seconds(20, Gtk.main_quit)
Gtk.main()
print("done", steps)
