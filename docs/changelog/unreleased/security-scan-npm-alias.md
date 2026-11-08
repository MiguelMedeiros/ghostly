---
section: For developers / CI
---
- The Security workflow's dependency scan checks an npm alias (`"foo": "npm:real@1.2.3"`) as the package it installs, so an advisory on that package is reported instead of being asked about under the alias's name.
