---
section: Fixed / CLI
---
- On the command line, `wallet create` refuses a source or a field you left out, or one the wallet does not take, as `bad_request` naming the flag (`lightning needs --provider: one of …`, `nwc needs --value uri=<…>`, `fedimint needs --invite <fed11…>`), instead of the app's words as an engine failure. A `--provider` or `--value` given to a wallet without sources is refused instead of dropped, and `wallet list` no longer offers the browser wallet (WebLN), which only works in a browser.
