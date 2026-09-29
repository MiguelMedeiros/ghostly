---
section: Security / Everywhere
---
- CLI: a contact's app opened with `service open` has a host name of its own (`http://<random>.localhost:<port>/`), so its cookies and storage are apart from every other app on this machine. The `url` it prints is a link for your browser: only a browser that followed it is served. Safari on macOS may not reach `*.localhost` names by itself; use Chrome or Edge, or add the name to `/etc/hosts`.
- CLI: an opened service whose answer is cut short (too large, or the contact dropped it) ends that response; it no longer stops the daemon. A daemon now logs an error nobody caught and keeps serving.
- CLI: the daemon makes the profile folder owner-only again before its socket is made in it.
- CLI: `listen` passes an event whose hook, output or cursor step fails, and goes on with the next.
- Received files never get a Windows device name (`CON`, `NUL`, `COM1.txt`...): such a name gets a `_` in front.
