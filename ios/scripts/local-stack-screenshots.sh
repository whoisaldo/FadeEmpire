#!/bin/zsh
# Captures the main screens with real data from the local Supabase stack (API on 56321),
# signed in as hassan@local.test and ali@local.test, on "FE Builder iPhone 16" (or the
# simulator named in FE_SIM, with FE_SHOT_PREFIX for the file names).
#
#   ios/scripts/local-stack-screenshots.sh [output-dir]
#
# The stack must be running (tools/local-stack.sh in the backend branch). The flows only open
# screens; they change nothing. Builds the Debug-Local configuration into ios/.build/dd-local.
set -euo pipefail

ROOT=${0:A:h:h}
OUT=${1:-$ROOT/screenshots/local-stack-$(date +%Y-%m-%d)}
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode-26.2.app/Contents/Developer}
DERIVED=$ROOT/.build/dd-local
SIM=${FE_SIM:-FE Builder iPhone 16}
PREFIX=${FE_SHOT_PREFIX:-6.1in}

UDID=$(xcrun simctl list devices -j | /usr/bin/python3 -c "
import json, sys
for devs in json.load(sys.stdin)['devices'].values():
    for d in devs:
        if d['name'] == sys.argv[1] and d['isAvailable']: print(d['udid']); break
" "$SIM" | head -1)
[[ -n $UDID ]] || { echo "No simulator named $SIM" >&2; exit 1; }

mkdir -p "$OUT"
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl status_bar "$UDID" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3
TEST_RUNNER_LOCAL_SHOTS_DIR="$OUT" TEST_RUNNER_SCREENSHOT_PREFIX="$PREFIX" \
  xcodebuild test -project "$ROOT/FadeEmpire.xcodeproj" -scheme FadeEmpire -configuration Debug-Local \
  -destination "platform=iOS Simulator,id=$UDID" -derivedDataPath "$DERIVED" \
  -clonedSourcePackagesDirPath "$ROOT/.build/spm" CODE_SIGNING_ALLOWED=NO \
  -only-testing:FadeEmpireUITests/LocalStackScreenshotTests -quiet
xcrun simctl status_bar "$UDID" clear

echo "Screenshots in $OUT"
ls "$OUT"
