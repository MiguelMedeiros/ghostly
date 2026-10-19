---
section: Fixed / Groups
---
- An app with no WebRTC (the CLI, or any app on a VPN) in many private groups no longer stalls every 15 seconds: each group connection waiting for a native listener read every group's whole member list, so twenty groups of fifteen blocked the app for 1.8 seconds per round. It now reads only the group it decides on (about 70 ms).
