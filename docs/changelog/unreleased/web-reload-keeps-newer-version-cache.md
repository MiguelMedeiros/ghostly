---
section: Fixed / Web
---
- The web app keeps opening without a connection after an update that came while an earlier one was still waiting. Reload on "New version" now takes the newest version, and an older version that starts while a newer one is still being saved (the last tab closed meanwhile) no longer deletes the newer one's offline copy. Before, both versions' copies could end up deleted, so the app did not open offline until the next update.
