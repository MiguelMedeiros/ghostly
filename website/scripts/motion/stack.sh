#!/bin/sh
# stack.sh <out> <height> <label> <clip.webm> [<label> <clip.webm> ...]
# Lays clips side by side, each scaled to <height> px with its label on top, the shorter ones holding their last
# frame, and writes <out>.mp4 plus a 10 fps <out>.gif for a PR. For comparing speeds.mjs recordings across builds:
# a clip with a <clip>.json beside it ({ "start": seconds }) is cut to begin a second before its scrolling does.
out=$1; h=$2; shift 2
font=/System/Library/Fonts/Supplemental/Arial.ttf
[ -f "$font" ] || font=$(fc-match -f '%{file}' sans 2>/dev/null)
inputs=""; filters=""; labels=""; n=0; longest=0
while [ $# -ge 2 ]; do
  label=$1; clip=$2; shift 2
  cut=0
  meta="${clip%.webm}.json"
  [ -f "$meta" ] && cut=$(sed 's/.*"start":\([0-9.]*\).*/\1/' "$meta" | awk '{print ($1 > 1) ? $1 - 1 : 0}')
  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$clip" | awk -v c="$cut" '{print $1 - c}')
  longest=$(echo "$d $longest" | awk '{print ($1 > $2) ? $1 : $2}')
  inputs="$inputs -ss $cut -i $clip"
  filters="$filters[$n:v]fps=25,scale=-2:$h,tpad=stop=-1:stop_mode=clone,pad=iw:ih+28:0:28:color=0x0b0f16,drawtext=fontfile=$font:text='$label':x=10:y=7:fontsize=15:fontcolor=white[v$n];"
  labels="$labels[v$n]"
  n=$((n + 1))
done
# shellcheck disable=SC2086
ffmpeg -loglevel error -y $inputs -filter_complex "${filters}${labels}hstack=inputs=$n[s]" -map "[s]" -t "$longest" -c:v libx264 -pix_fmt yuv420p -crf 26 "$out.mp4"
ffmpeg -loglevel error -y -i "$out.mp4" -vf "fps=10,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "$out.gif"
ls -la "$out.mp4" "$out.gif" | awk '{print $5, $9}'
