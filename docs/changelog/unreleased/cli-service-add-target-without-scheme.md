---
section: Fixed / CLI
---
- `ghostly service add` takes a target without `http://` (`localhost:8080`, `127.0.0.1:8080`) as the app does. Before, `localhost:8080` was refused as "Only a web app on this machine (127.0.0.1, localhost) can be shared" and `127.0.0.1:8080` was "Not a URL". A target off this machine is refused in one sentence that names the hosts allowed (localhost, 127.0.0.1 or [::1]), the one the app says.
