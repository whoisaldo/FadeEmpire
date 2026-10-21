# Fade Empire barber app (iOS)

SwiftUI, iOS 17+, built against `docs/barber-app/CONTRACT.md` and migration `0022_barber_app.sql` as built. The Xcode project is generated:
edit `project.yml`, then run `xcodegen generate` and commit both.

## Configurations

| Configuration | Backend | Values |
| --- | --- | --- |
| `Debug-Local` | local stack, `http://127.0.0.1:56321` | `Config/Debug-Local.xcconfig`, with the local stack's demo anon key (local only) |
| `Debug` | production | `Config/Debug.xcconfig` (from `scripts/config.js`) |
| `Release` | production | `Config/Release.xcconfig` |

Push tokens register with the APNs environment the build is signed for, read from the provisioning profile at
launch: `sandbox` for a development-signed build run from Xcode (Debug or Release), `production` for TestFlight and
the App Store (no `embedded.mobileprovision`) and for ad hoc builds. The simulator registers `sandbox`.

## Mock backend

Launch arguments: `-mock-backend` (in-memory data, same permission rules), `-mock-now 2026-10-22T13:00`
(pins the clock, shop time), `-mock-session hassan@local.test` (starts signed in), `-mock-must-change
hassan@local.test` (that login must pick a new password, as after a reset). Logins: `ali@local.test`
(manager), `hassan@local.test`, `larry@local.test`; password `fade-local-1`. As on the local stack, none of
them is forced to change it. `-mock-fault me:network:1,barberSchedule:network:*` makes those calls fail with no
network (or `server_code` in place of `network`), for that many calls or `*` for every call; the call names are
`MockBackend.Call`. Unit tests can also delay calls with `MockBackend.inject`.

## Build and test

```sh
export DEVELOPER_DIR=/Applications/Xcode-26.2.app/Contents/Developer
xcodebuild test -project ios/FadeEmpire.xcodeproj -scheme FadeEmpire \
  -destination 'platform=iOS Simulator,name=FE Builder iPhone 16' \
  -derivedDataPath ios/.build/dd -clonedSourcePackagesDirPath ios/.build/spm CODE_SIGNING_ALLOWED=NO
```

`ios/scripts/screenshots.sh [dir]` captures every main screen at 6.1" and 6.9" into `ios/screenshots/<date>/`.

## Against the local stack

With the stack running (`tools/local-stack.sh start` in the backend branch), the `FadeEmpireIntegration` scheme
runs `FadeEmpireIntegrationTests` on the Debug-Local build. It calls every `Backend` method through
`SupabaseBackend` as the three seeded logins, plus a throwaway barber and login it creates, and removes what it
creates (bookings cancelled, links, tokens and days off deleted, the test barber deactivated and its login turned
off). Without `FE_INTEGRATION=1` every test skips, so the normal run never touches a server.

```sh
TEST_RUNNER_FE_INTEGRATION=1 xcodebuild test -project ios/FadeEmpire.xcodeproj -scheme FadeEmpireIntegration \
  -destination 'platform=iOS Simulator,name=FE Builder iPhone 16' \
  -derivedDataPath ios/.build/dd-local -clonedSourcePackagesDirPath ios/.build/spm CODE_SIGNING_ALLOWED=NO
```

`ios/scripts/local-stack-screenshots.sh [dir]` captures the main screens with the stack's data, signed in as
Hassan and as Ali.
`ios/scripts/make-icon.swift` rebuilds the app icon from `assets/brand/logo-mark.png`.
