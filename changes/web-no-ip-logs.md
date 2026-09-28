---
section: Security / Privacy
---
- app.ghostly.tools no longer logs who visits: its server records only the time, the file and the response, with no IP
  address, browser, referrer or query string, and error lines that would name a visitor are left out. Container logs
  of the web app and the site are capped at 30 MB instead of growing forever.
