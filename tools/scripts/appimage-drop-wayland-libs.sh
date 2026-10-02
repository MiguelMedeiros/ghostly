#!/usr/bin/env bash
# Removes the libwayland libraries that linuxdeploy bundles into the AppImage.
#
# They come from the build machine (Ubuntu 22.04) and clash with the newer Mesa
# on the user's system. On Wayland desktops such as openSUSE Leap 16 or Fedora
# the app then dies at start with
#   Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
# Every desktop that runs GTK already has libwayland-client, so the system copy
# is used. libwayland-server stays: X11-only systems may not have it.
# Upstream: https://github.com/tauri-apps/tauri/issues/11994
#
# Needs squashfs-tools. Usage: appimage-drop-wayland-libs.sh <file.AppImage>...
set -euo pipefail

for appimage in "$@"; do
  appimage=$(realpath "$appimage")
  work=$(mktemp -d)

  # The AppImage is a small runtime followed by a squashfs image.
  offset=$("$appimage" --appimage-offset)
  unsquashfs -q -no-progress -d "$work/root" -o "$offset" "$appimage"

  removed=$(find "$work/root/usr/lib" -maxdepth 1 \( -name 'libwayland-client.so*' -o -name 'libwayland-cursor.so*' -o -name 'libwayland-egl.so*' \) -print -delete)
  if [ -z "$removed" ]; then
    echo "no bundled libwayland in $appimage; left unchanged"
    rm -rf "$work"
    continue
  fi
  echo "removed from $(basename "$appimage"):"
  echo "$removed" | sed "s#$work/root/#  #"

  # Same settings linuxdeploy used, so the runtime can still mount it.
  mksquashfs "$work/root" "$work/image.squashfs" -root-owned -noappend -comp zstd -b 131072 -quiet -no-progress
  head -c "$offset" "$appimage" > "$work/new.AppImage"
  cat "$work/image.squashfs" >> "$work/new.AppImage"
  chmod 755 "$work/new.AppImage"
  mv "$work/new.AppImage" "$appimage"
  rm -rf "$work"
done
