---
section: Fixed / CLI
---
- `ghostly file send --voice` refuses a WAV whose header gives more than 255 channels or a sample rate outside 1 to 768 kHz as not audio (`bad_request`: "… is not audio (a WAV with 65535 channels at 8000 Hz, which no sound has…)"), before reading its samples. Before, the header was trusted: a small file saying 65,535 channels took over 1 GB of memory while it was read, and one saying 4 GHz a 366 MB meter, before it was refused.
