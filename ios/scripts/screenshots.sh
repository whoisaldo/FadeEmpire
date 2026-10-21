#!/bin/zsh
# Captures every main screen on the MockBackend at an iPhone 6.1" size (iPhone 16) and a
# 6.9" size (iPhone 17 Pro Max), into ios/screenshots/<date>/ unless a folder is given.
#
#   ios/scripts/screenshots.sh [output-dir]
#
# Uses only simulators named "FE Builder …" (created here when missing). Set DEVELOPER_DIR to
# pick an Xcode; the default is the one whose simulators this machine's runtime serves.
set -euo pipefail

ROOT=${0:A:h:h}
OUT=${1:-$ROOT/screenshots/$(date +%Y-%m-%d)}
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode-26.2.app/Contents/Developer}
RUNTIME=com.apple.CoreSimulator.SimRuntime.iOS-26-2
DERIVED=$ROOT/.build/dd

device() {  # name, device type → UDID (created if missing)
  local udid
  udid=$(xcrun simctl list devices -j | /usr/bin/python3 -c "
import json, sys
for devs in json.load(sys.stdin)['devices'].values():
    for d in devs:
        if d['name'] == sys.argv[1] and d['isAvailable']: print(d['udid']); break
" "$1" | head -1)
  [[ -n $udid ]] || udid=$(xcrun simctl create "$1" "$2" $RUNTIME)
  echo $udid
}

mkdir -p "$OUT"
SMALL=$(device "FE Builder iPhone 16" com.apple.CoreSimulator.SimDeviceType.iPhone-16)
LARGE=$(device "FE Builder iPhone 17 Pro Max" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max)

xcodebuild build-for-testing -project "$ROOT/FadeEmpire.xcodeproj" -scheme FadeEmpire \
  -destination "platform=iOS Simulator,id=$SMALL" -derivedDataPath "$DERIVED" \
  -clonedSourcePackagesDirPath "$ROOT/.build/spm" CODE_SIGNING_ALLOWED=NO -quiet

for pair in "6.1in:$SMALL" "6.9in:$LARGE"; do
  prefix=${pair%%:*}; udid=${pair#*:}
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null
  xcrun simctl status_bar "$udid" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3
  TEST_RUNNER_SCREENSHOT_DIR="$OUT" TEST_RUNNER_SCREENSHOT_PREFIX="$prefix" \
    xcodebuild test-without-building -project "$ROOT/FadeEmpire.xcodeproj" -scheme FadeEmpire \
    -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$DERIVED" \
    -only-testing:FadeEmpireUITests/ScreenshotTests -quiet
  xcrun simctl status_bar "$udid" clear
done

echo "Screenshots in $OUT"
ls "$OUT"
