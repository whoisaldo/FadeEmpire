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
# (scripts/shop-video.js picks). The mirror-check poster is its first frame so
# autoplay doesn't visibly jump. The tour's first seconds are the LED ceiling,
# which on a phone sits right above the interior photo, so its posters are the
# frame at TOUR_POSTER_AT: the chairs and the room, no people. Reduced-motion
# visitors only ever see the poster.
#
# Posters alone, from the committed clips (no source needed):
#   tools/build-video.sh posters

set -euo pipefail
cd "$(dirname "$0")/.."

TOUR_SRC="${TOUR_SRC:-$HOME/Desktop/newFadeEmpireAssets/FadeEmpireOfficialVideo.MP4}"
TOUR_POSTER_AT=21.1
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
}

poster() {                      # poster <stem> [seconds]: one frame of the encoded clip
  ffmpeg -v error -y -ss "${2:-0}" -i "$OUT/$1.mp4" -frames:v 1 -q:v 3 "assets/img/$1-poster.jpg"
}

posters() {
  echo "Posters:"
  for stem in shop-tour-720 shop-tour-540; do
    [[ -f "$OUT/$stem.mp4" ]] && { echo "  $stem at ${TOUR_POSTER_AT}s"; poster "$stem" "$TOUR_POSTER_AT"; }
  done
  echo "  mirror-check, first frame"; poster mirror-check
}

if [[ "${1:-}" == posters ]]; then posters; exit; fi

echo "Encoding video:"
if [[ -f "$TOUR_SRC" ]]; then
  encode "$TOUR_SRC" shop-tour-720 1080 keep 26     # desktop plate
  encode "$TOUR_SRC" shop-tour-540 810  keep 28     # phones: about half the bytes
else
  echo "  shop-tour skipped: source not found at $TOUR_SRC"
fi
encode "$MIRROR_SRC" mirror-check 960 drop 27
posters

ls -la "$OUT"
