---
section: For developers / Tests
---
- The D-Bus session bus each Linux Desktop end-to-end app gets starts no service by itself. It read the system's session configuration, so on a Linux desktop the app's first call into xdg-desktop-portal started a whole set of portals on the person's live Wayland session, one set per test, and on Hyprland xdg-desktop-portal-hyprland crashed as each bus went away (a crash notice per test).
