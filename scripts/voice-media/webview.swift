import Cocoa
import WebKit

// The system WKWebView — the engine Ghostly Desktop runs in on macOS — with nobody at the screen:
// loads the page given as the first argument into an offscreen window, prints the first message the
// page posts to `window.webkit.messageHandlers.done`, and exits. No microphone, no sound: the pages
// this runs record from an oscillator and play muted.
// Usage: swiftc -O webview.swift -o webview && ./webview page.html
class Done: NSObject, WKScriptMessageHandler {
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    print(message.body)
    fflush(stdout)
    exit(0)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let config = WKWebViewConfiguration()
config.mediaTypesRequiringUserActionForPlayback = []
let done = Done()
config.userContentController.add(done, name: "done")
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: config)
let window = NSWindow(contentRect: NSRect(x: -5000, y: -5000, width: 400, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = web
let html = try! String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
// An origin of its own, so the policy's 'self' means something (a custom scheme would not run the page).
web.loadHTMLString(html, baseURL: URL(string: "https://tauri.localhost/"))
DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
  print("{\"error\":\"timed out\"}")
  exit(2)
}
app.run()
