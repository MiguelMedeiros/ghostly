---
section: Fixed / Everywhere
---
- Scanning a QR code with the camera (Join, adding a device, wallet Send) now stops and says the camera is unavailable when the camera ends during the scan. In the Android app this happened every time you left the app mid-scan: on your return the preview stayed frozen on its last frame, no code was ever read, and the app kept reading that frame, even in the background.
