---
section: Fixed / Apps
---
- A shared service whose answer was larger than about 100 KB (a page, an image, a download) failed with "The local service dropped the response." when the chat was connected through Iroh or HyperDHT (the Desktop app, or the web app on Iroh). The answer now arrives whole at the connection's pace, as it already did over WebRTC.
