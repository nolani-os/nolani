#!/usr/bin/env bash
# Cut the showcase recordings (browser_schaufenster.py) into README media:
#   <name>.mp4   H.264, full size, real time, lead-in cut off (to watch or download)
#   <name>.webp  animated preview for the README (960 px wide, 10 fps, sped up by FAKTOR)
#   screenshots  PNG → WebP (quality 82), the phone at half size
#
#   ./schaufenster_schnitt.sh <schaufenster-dir> <out-dir>
# Needs ffmpeg (with libwebp) and python3. Speed-ups per video: FAKTOR_<name> (default 1).
set -euo pipefail
IN=$1 OUT=$2
mkdir -p "$OUT"
vorlauf() { python3 -c "import json,sys;print(json.load(open('$IN/szenen.json')).get('vorlauf_s_$1',0))"; }

for v in "$IN"/video/*.webm; do
  [ -e "$v" ] || continue
  name=$(basename "$v" .webm)
  ab=$(vorlauf "$name")
  faktor_var="FAKTOR_$name"; faktor=${!faktor_var:-1}
  ffmpeg -loglevel error -y -ss "$ab" -i "$v" -c:v libx264 -preset slow -crf 26 -pix_fmt yuv420p \
    -movflags +faststart -an "$OUT/$name.mp4"
  ffmpeg -loglevel error -y -ss "$ab" -i "$v" \
    -vf "setpts=PTS/$faktor,fps=10,scale=960:-2:flags=lanczos" \
    -c:v libwebp_anim -quality 55 -compression_level 6 -loop 0 -an "$OUT/$name.webp"
  echo "$name: ab ${ab}s, Vorschau ×$faktor — $(du -h "$OUT/$name.mp4" | cut -f1) mp4, $(du -h "$OUT/$name.webp" | cut -f1) webp"
done

for p in "$IN"/screenshots/*.png; do
  [ -e "$p" ] || continue
  name=$(basename "$p" .png)
  case "$name" in mobile-*) skal="scale=iw/2:-2:flags=lanczos" ;; *) skal="null" ;; esac
  ffmpeg -loglevel error -y -i "$p" -vf "$skal" -c:v libwebp -quality 82 "$OUT/$name.webp"
done
echo "Bilder: $(ls "$OUT"/*.webp | wc -l) WebP, zusammen $(du -ch "$OUT"/* | tail -1 | cut -f1)"
