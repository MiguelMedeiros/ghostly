---
section: Fixed / Devices
---
- Moving a profile to a Desktop that runs in a space of its own (`GHOSTLY_PROFILE`) no longer ends with an empty profile there. The move finished, then the cleanup of the old copy deleted the list of profiles too, so the Desktop opened an empty profile and the other device showed it active but not connected. If the pointer to a moved profile is ever lost, the app now finds the profile again when it starts.
