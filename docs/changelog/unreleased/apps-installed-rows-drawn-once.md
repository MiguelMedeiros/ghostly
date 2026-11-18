---
section: Fixed / Apps
---
- The Apps page no longer draws every installed and built-in app's row again when nothing in them changed: when a message shows or closes, or the Add screen, an app's details or its chat picker opens or closes. With 100 installed apps, each of those took about 20 ms in tests; now only a row whose app changed is drawn again.
