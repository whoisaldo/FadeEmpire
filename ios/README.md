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

A push tap without SpringBoard, through the same `AppDelegate.handleTap` a real notification response uses:
`-mock-open-push '{"barber_id":"…","booking_date":"2026-10-26","kind":"booked","booking_id":"…","event_id":1}'` is
tapped at cold launch, and `-mock-warm-push '<same shape>'` is tapped the next time the app returns from the
background (press Home, then reopen it). Both work only with `-mock-backend`.

`DynamicTypeTests` runs at the largest accessibility text size (`-UIPreferredContentSizeCategoryName
UICTContentSizeCategoryAccessibilityXXXL`). With `TEST_RUNNER_DYNAMIC_TYPE_SHOTS_DIR=<dir>` it also writes its
screenshots there.

## Build and test

Any Xcode 26.x with the iOS 26.2 SDK builds it; on this Mac both `/Applications/Xcode-26.2.app` and
`/Applications/Xcode-26.3.0.app` work.

```sh
export DEVELOPER_DIR=/Applications/Xcode-26.2.app/Contents/Developer   # or Xcode-26.3.0.app
xcodebuild test -project ios/FadeEmpire.xcodeproj -scheme FadeEmpire \
  -destination 'platform=iOS Simulator,name=FE Builder iPhone 16' \
  -derivedDataPath ios/.build/dd -clonedSourcePackagesDirPath ios/.build/spm CODE_SIGNING_ALLOWED=NO
```

`ios/scripts/screenshots.sh [dir]` captures every main screen at 6.1" and 6.9" into `ios/screenshots/<date>/`.

## Against the local stack

With the stack running (`tools/local-stack.sh start`), the `FadeEmpireIntegration` scheme
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

## Ship to the barbers (TestFlight)

Once, in Apple's portals (team `9X79V37Q89`):

1. App Store Connect -> Apps -> New App: iOS, bundle ID `com.chicopeefadeempire.barbers` (register the App ID
   under Certificates, Identifiers & Profiles first if it is not in the list).
2. On that App ID, turn on **Push Notifications**.
3. Keys -> new key with **Apple Push Notifications service (APNs)**. Download the `.p8` (only once) and note its
   Key ID. Run the deploy script again with `APNS_KEY_ID=<key id> APNS_TEAM_ID=9X79V37Q89
   APNS_KEY_FILE=~/AuthKey_<key id>.p8` added to its usual environment (README.md, Deploy); it sets the secrets.
4. On the Mac that archives, sign Xcode into the Apple ID (Xcode -> Settings -> Accounts), so automatic signing
   can make the distribution certificate and profile. Without a signed-in Xcode (over SSH), use an App Store
   Connect API key (Users and Access -> Integrations, Admin role) with `-allowProvisioningUpdates
   -authenticationKeyPath <AuthKey.p8> -authenticationKeyID <id> -authenticationKeyIssuerID <issuer>` on both
   `xcodebuild` commands below.

Each build:

1. Bump `CURRENT_PROJECT_VERSION` in `project.yml` (App Store Connect refuses a build number it has seen; raise
   `MARKETING_VERSION` for a new version), then `xcodegen generate` and commit both.
2. Archive the Release configuration and upload it. In Xcode: scheme FadeEmpire, destination Any iOS Device,
   Product -> Archive, then Distribute App -> App Store Connect. Or:

   ```sh
   export DEVELOPER_DIR=/Applications/Xcode-26.3.0.app/Contents/Developer
   xcodebuild archive -project ios/FadeEmpire.xcodeproj -scheme FadeEmpire -configuration Release \
     -destination 'generic/platform=iOS' -archivePath ios/.build/FadeEmpire.xcarchive -allowProvisioningUpdates
   rm -f ios/.build/ExportOptions.plist
   /usr/libexec/PlistBuddy -c 'Add :method string app-store-connect' -c 'Add :destination string upload' \
     -c 'Add :teamID string 9X79V37Q89' ios/.build/ExportOptions.plist
   xcodebuild -exportArchive -archivePath ios/.build/FadeEmpire.xcarchive \
     -exportOptionsPlist ios/.build/ExportOptions.plist -exportPath ios/.build/export -allowProvisioningUpdates
   ```

   The export encryption question is already answered (`ITSAppUsesNonExemptEncryption` is false).
3. When the build has processed (App Store Connect -> TestFlight), add Hassan and Larry as testers: internal
   testers must be App Store Connect users (Users and Access); external testers only need an email, and their first
   build waits for Beta App Review. They install it from the TestFlight app.
4. Sign in to the app as the manager and create their logins in the Barbers tab. Each gets a temporary password,
   shown once, to hand over; they pick their own at first sign-in.
