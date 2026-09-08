#!/usr/bin/env bash
# Encode the two clips the site plays. Needs ffmpeg (brew install ffmpeg).
#
#   shop-tour     the professionally edited tour of the shop (has a voice track,
#                 the site starts it muted with a sound toggle)
#   mirror-check  a 13 s silent loop of a customer checking his cut, used as a
#                 motion plate in the gallery
#
# Sources stay OUT of the repo (the tour master alone is 15 MB); point at them:
#   TOUR_SRC=~/Desktop/newFadeEmpireAssets/FadeEmpireOfficialVideo.MP4 tools/build-video.sh
# The mirror clip source is committed at assets/Haircuts/Haircut1_video.mov.
#
# Every output is H.264 (High) at 30 fps, yuv420p (plays on every phone) and
# faststart (starts before the download finishes). VP9 was tried and came out
# larger than x264 at matching quality on this footage, so there is no WebM.
# The tour is encoded twice: 540 px wide for phones, 720 px wide for desktop
# (scripts/shop-video.js picks). Posters are the first frame of each clip so
# autoplay doesn't visibly jump.

set -euo pipefail
cd "$(dirname "$0")/.."

TOUR_SRC="${TOUR_SRC:-$HOME/Desktop/newFadeEmpireAssets/FadeEmpireOfficialVideo.MP4}"
MIRROR_SRC="assets/Haircuts/Haircut1_video.mov"
OUT=assets/video
mkdir -p "$OUT" assets/img

encode() {                      # encode <src> <stem> <height> <audio: keep|drop> [crf]
  local src="$1" stem="$2" h="$3" audio="$4" crf="${5:-26}"
  local a=(-an)
  [[ "$audio" == keep ]] && a=(-c:a aac -b:a 96k -ac 2)
  echo "  $stem ($h p, crf $crf)"
  ffmpeg -v error -y -i "$src" \
    -vf "scale=-2:$h,fps=30,format=yuv420p" \
    -c:v libx264 -profile:v high -level 4.0 -preset slow -crf "$crf" \
    -movflags +faststart "${a[@]}" "$OUT/$stem.mp4"
  ffmpeg -v error -y -i "$OUT/$stem.mp4" -frames:v 1 -q:v 3 "assets/img/$stem-poster.jpg"
}

echo "Encoding video:"
if [[ -f "$TOUR_SRC" ]]; then
  encode "$TOUR_SRC" shop-tour-720 1080 keep 26     # desktop plate
  encode "$TOUR_SRC" shop-tour-540 810  keep 28     # phones: about half the bytes
else
  echo "  shop-tour skipped: source not found at $TOUR_SRC"
fi
encode "$MIRROR_SRC" mirror-check 960 drop 27

ls -la "$OUT"
