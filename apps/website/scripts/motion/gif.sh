#!/bin/sh
# gif.sh <inDir> <outDir>: every WebM to a GIF (desktop 640 wide, phone 300 wide, 12 fps) plus a copy of the WebM.
in=$1; out=$2; mkdir -p "$out"
for f in "$in"/*.webm; do
  n=$(basename "$f" .webm)
  case "$n" in phone-*) w=280;; *) w=560;; esac
  ffmpeg -loglevel error -y -i "$f" -vf "fps=10,scale=$w:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$out/$n.gif"
  cp "$f" "$out/$n.webm"
done
du -sh "$out"; ls -la "$out" | awk '{print $5, $9}' | sort -n | tail -5
