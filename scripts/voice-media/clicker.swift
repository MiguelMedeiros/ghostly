import Cocoa
import WebKit

// A manual probe, not a CI gate: real AppKit mouse events into a macOS WKWebView (Ghostly Desktop's engine),
// which no WebDriver reaches and Playwright's WebKit does not model (it has no inactive window).
//
// It loads the voice recorder gallery (apps/web/voice-gallery.html, which records a tone instead of the microphone),
// locks a recording with a click or a slide up, then clicks Send once and prints whether it was sent.
//
//   npx vite web --port 4731 &
//   swiftc -O scripts/voice-media/clicker.swift -o /tmp/clicker
//   /tmp/clicker "http://localhost:4731/voice-gallery.html?tone" click activate deactivate            # sent=0
//   /tmp/clicker "http://localhost:4731/voice-gallery.html?tone" click activate deactivate firstmouse # sent=1
//
// Flags: `click` or `slide` (how it locks); `activate` shows the window and makes the app active (it takes
// focus for a few seconds); `deactivate` makes the app inactive after the lock, as a microphone prompt or
// another app does; `firstmouse` makes the view accept the first mouse, as `acceptFirstMouse` in
// apps/desktop/tauri.conf.json does for the app. Without `activate` the window sits off screen and is key
// only by chance, so clicks may never reach the page.

class KeyWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

let args = CommandLine.arguments
let firstMouse = args.contains("firstmouse")
let activate = args.contains("activate")
let slide = args.contains("slide")

class ProbeWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { firstMouse }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let W: CGFloat = 640, H: CGFloat = 240
let config = WKWebViewConfiguration()
config.mediaTypesRequiringUserActionForPlayback = []
let web = ProbeWebView(frame: NSRect(x: 0, y: 0, width: W, height: H), configuration: config)
let window = KeyWindow(contentRect: NSRect(x: activate ? 40 : -3000, y: 40, width: W, height: H), styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = web
window.makeKeyAndOrderFront(nil)
if activate { app.activate(ignoringOtherApps: true) }
web.load(URLRequest(url: URL(string: args[1])!))

@MainActor func js(_ source: String) async -> Any? { try? await web.evaluateJavaScript(source) }
func pause(_ ms: Int) async { try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) }

var eventNumber = 0
/** One mouse event at a point of the page (CSS pixels from the top left), through the window like a real one. */
@MainActor func mouse(_ type: NSEvent.EventType, _ x: CGFloat, _ y: CGFloat) {
  eventNumber += 1
  let event = NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: H - y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
    windowNumber: window.windowNumber, context: nil, eventNumber: eventNumber, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)!
  window.sendEvent(event)
}

@MainActor func click(_ x: CGFloat, _ y: CGFloat) async {
  mouse(.mouseMoved, x, y); await pause(30)
  mouse(.leftMouseDown, x, y); await pause(90)
  mouse(.leftMouseUp, x, y)
}

@MainActor func report(_ label: String) async {
  let page = await js("(() => { const bar = document.querySelector('[data-testid=voice-bar]'); const button = document.querySelector('.voice-record-button'); return `mode=${bar?.dataset.mode ?? 'idle'} button=${button?.dataset.testid} focus=${document.activeElement?.dataset?.testid ?? document.activeElement?.tagName} sent=${window.sent.length}`; })()") as? String
  print("[\(label)] \(page ?? "?") windowKey=\(window.isKeyWindow) appActive=\(app.isActive)")
}

Task { @MainActor in
  for _ in 0..<100 {
    if let ready = await js("!!document.querySelector('[data-testid=voice-record]')") as? Bool, ready { break }
    await pause(100)
  }
  let center = await js("(() => { const box = document.querySelector('.voice-record-button').getBoundingClientRect(); return [box.x + box.width / 2, box.y + box.height / 2]; })()") as! [Double]
  let x = CGFloat(center[0]), y = CGFloat(center[1])
  if slide {
    mouse(.mouseMoved, x, y); await pause(30)
    mouse(.leftMouseDown, x, y); await pause(700)
    for step in 1...12 { mouse(.leftMouseDragged, x, y - CGFloat(step) * 11); await pause(16) }
    mouse(.leftMouseUp, x, y - 132)
  } else {
    await click(x, y)
  }
  await pause(1500)
  await report("locked")
  if args.contains("deactivate") {
    app.deactivate()
    await pause(500)
    await report("app made inactive")
  }
  await click(x, y)
  await pause(1000)
  await report("after ONE click on Send")
  if let trace = await js("window.trace.join('\\n')") as? String { print(trace) }
  exit(0)
}
app.run()
