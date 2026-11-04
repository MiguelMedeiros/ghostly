---
section: Fixed / Devices
---
- Moving a profile back to a device that already holds its photos, voice notes and other files up to 16 MB no longer writes each of them twice on that device. They stay where they are and only what changed crosses over. Before, every move back wrote about twice the size of those files and read each one back, however little had changed. In a test, a move back with 400 photos already on the device wrote none of them; before, it wrote 6.5 MB and read back 6.5 MB.
