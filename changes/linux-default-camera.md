---
section: Fixed / Calls
---
- On Linux, video calls show your picture on laptops whose camera works only through libcamera, like recent Intel ones. With no camera chosen, the app now uses the camera PipeWire or libcamera lists first. Before, it opened the raw video device, got no picture, and the other side saw black.
