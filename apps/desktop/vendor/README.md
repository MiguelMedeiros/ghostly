# Vendored crates

Each crate here is a published crate, copied whole at the exact version `Cargo.lock` pins, with the smallest change
Ghostly needs. The workspace `Cargo.toml` puts it in place of the crates.io one (`[patch.crates-io]`) and keeps it out
of the workspace's members (`exclude`), so it is built as a dependency and not linted or tested as Ghostly's own.
Drop the copy, and its `[patch.crates-io]` line, once the version Ghostly uses has the change upstream.

## tauri 2.12.2

From `tauri-2.12.2.crate` on crates.io, byte for byte, but for:

- `Cargo.lock` removed: a dependency's lockfile is never read, and the repository's dependency scan reads every
  lockfile it finds.
- `src/ipc/protocol.rs`, `src/ipc/mod.rs`: `tauri::ipc::set_post_message_limit(fn(&str) -> Option<usize>)`, the
  largest IPC message a webview may post, by its label (`None`: no limit). `handle_ipc_message` drops a larger body
  before it is parsed. Without a call to it, Tauri behaves as before.

```diff
--- a/src/ipc/protocol.rs
+++ b/src/ipc/protocol.rs
@@ -28,6 +28,15 @@
 const TAURI_RESPONSE_HEADER_NAME: &str = "Tauri-Response";
 const TAURI_RESPONSE_HEADER_ERROR: &str = "error";
 const TAURI_RESPONSE_HEADER_OK: &str = "ok";
+
+static POST_MESSAGE_LIMIT: std::sync::OnceLock<fn(&str) -> Option<usize>> =
+  std::sync::OnceLock::new();
+
+/// Sets the largest post-message IPC body a webview may send, by its label (`None`: no limit). A larger body is
+/// dropped before it is parsed, which on Linux happens on the main thread. The first call wins.
+pub fn set_post_message_limit(limit: fn(&str) -> Option<usize>) {
+  let _ = POST_MESSAGE_LIMIT.set(limit);
+}
 
 pub fn message_handler<R: Runtime>(
   manager: Arc<AppManager<R>>,
@@ -183,6 +192,11 @@
 }
 
 fn handle_ipc_message<R: Runtime>(request: Request<String>, manager: &AppManager<R>, label: &str) {
+  if let Some(max) = POST_MESSAGE_LIMIT.get().and_then(|limit| limit(label)) {
+    if request.body().len() > max {
+      return;
+    }
+  }
   let Some(webview) = manager.get_webview(label) else {
     return;
   };
--- a/src/ipc/mod.rs
+++ b/src/ipc/mod.rs
@@ -30,6 +30,7 @@
 mod command;
 pub(crate) mod format_callback;
 pub(crate) mod protocol;
+pub use protocol::set_post_message_limit;
```

Why: the post-message IPC path parses the whole body into a `serde_json::Value` before any command sees it, and on
Linux that runs on the GTK main thread, which every window shares. Ghostly's app windows can only post (their CSP
blocks the `ipc:` scheme), and the broker takes at most 64 KiB; `app_sandbox::message_limit` bounds their messages
to 128 KiB, and the Ghostly window's not at all. The custom-protocol (`ipc:`) path is unchanged.

To check the copy: unpack `~/.cargo/registry/cache/*/tauri-2.12.2.crate` and diff it against this directory; the
only differences are the ones above.
