---
section: Fixed / Chat
---
- A WAV or Ogg audio file with tags a tagger added at its end (ID3v1, APE), or a WAV with a chunk that lacks its last padding byte, is sent again without the details saved in it. Before, these files played everywhere but were refused with "This audio cannot be sent".
