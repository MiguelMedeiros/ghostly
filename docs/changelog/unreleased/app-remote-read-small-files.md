---
section: Fixed / Apps
---
- An app reading many small files from a contact (a photo gallery, say) is no longer cut off after about 32 reads in a second. The contact now counts the bytes it actually sends, not the full length asked for. When the contact does ask an app to slow down, the app now hears "too-fast" (wait and try again) instead of a plain "failed".
