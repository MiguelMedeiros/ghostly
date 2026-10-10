---
section: Fixed / Devices
---
- Moving a profile back to a device that still holds its files starts sooner: that device opened its old copy's database once for each file and read every copied file twice. It now opens it once and checks each file as it copies it.
