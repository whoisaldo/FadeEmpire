# Fade Empire barber app (iOS)

SwiftUI, iOS 17+, built against `docs/barber-app/CONTRACT.md`. The Xcode project is generated:
edit `project.yml`, then run `xcodegen generate` and commit both.

## Configurations

| Configuration | Backend | Values |
| --- | --- | --- |
| `Debug-Local` | local stack, `http://127.0.0.1:55321` | `Config/Debug-Local.xcconfig`; fill `SUPABASE_PUBLISHABLE_KEY` with the local anon key |
| `Debug` | production | `Config/Debug.xcconfig` (from `scripts/config.js`) |
| `Release` | production | `Config/Release.xcconfig`; push tokens register as `production` |

## Mock backend

Launch arguments: `-mock-backend` (in-memory data, same permission rules), `-mock-now 2026-10-22T13:00`
(pins the clock, shop time), `-mock-session hassan@local.test` (starts signed in). Logins:
`ali@local.test` (manager), `hassan@local.test` (must pick a new password), `larry@local.test`; password
`fade-local-1`.

## Build and test

```sh
export DEVELOPER_DIR=/Applications/Xcode-26.2.app/Contents/Developer
xcodebuild test -project ios/FadeEmpire.xcodeproj -scheme FadeEmpire \
  -destination 'platform=iOS Simulator,name=FE Builder iPhone 16' \
  -derivedDataPath ios/.build/dd -clonedSourcePackagesDirPath ios/.build/spm CODE_SIGNING_ALLOWED=NO
```

`ios/scripts/screenshots.sh [dir]` captures every main screen at 6.1" and 6.9" into `ios/screenshots/<date>/`.
`ios/scripts/make-icon.swift` rebuilds the app icon from `assets/brand/logo-mark.png`.
