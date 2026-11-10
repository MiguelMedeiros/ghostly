---
section: Fixed / Devices
---
- Add a device now waits while your profile is moving to another device, or while a device is being removed, as Rename and Remove already do. Before, a device added during a move could get the profile's device secret without ever joining, and the profile never replaced that secret.
