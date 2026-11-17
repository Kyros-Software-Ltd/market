#!/bin/bash
# Builds Market's control app: WebDriverAgent with FBMarketCommands.m added (saving into Photos).
# Runs on a Mac (GitHub's macOS runners, see .github/workflows/control-app.yml). The build is the
# same as WebDriverAgent's own real-device package (Scripts/ci/build-real.sh in its repo):
# unsigned, arm64, Debug, the top-level Frameworks folder left out. Market's sideloading signs it.
#
#   WDA_TAG=v16.15.3 OUT=/tmp/out bash controlapp/build.sh
# Writes $OUT/WebDriverAgentRunner-Runner.zip and $OUT/wda-version.txt.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$PWD}"
WORK="$(mktemp -d)"
if [ -z "${WDA_TAG:-}" ]; then
    WDA_TAG="$(curl -fsSL https://api.github.com/repos/appium/WebDriverAgent/releases/latest |
        python3 -c 'import json, sys; print(json.load(sys.stdin)["tag_name"])')"
fi
echo "Building WebDriverAgent $WDA_TAG with Market's additions"

git clone --quiet --depth 1 --branch "$WDA_TAG" https://github.com/appium/WebDriverAgent.git "$WORK/wda"
cat "$HERE/FBMarketCommands.m" >> "$WORK/wda/WebDriverAgentLib/Commands/FBCustomCommands.m"

cd "$WORK/wda"
xcodebuild clean build-for-testing \
    -project WebDriverAgent.xcodeproj \
    -derivedDataPath "$WORK/dd" \
    -scheme WebDriverAgentRunner \
    -destination generic/platform=iOS \
    CODE_SIGNING_ALLOWED=NO ARCHS=arm64 | tail -n 25

PRODUCTS="$WORK/dd/Build/Products/Debug-iphoneos"
APP="$PRODUCTS/WebDriverAgentRunner-Runner.app"
# Asking for Photos access without this text makes iOS end the app.
/usr/libexec/PlistBuddy -c \
    "Add :NSPhotoLibraryAddUsageDescription string 'Market saves the photos and videos you send from your PC.'" \
    "$APP/Info.plist"

# Same packaging as WebDriverAgent's release: the phone's own copies of the XCTest libraries
# are used instead of the ones Xcode bundles in Frameworks/.
cd "$PRODUCTS"
rm -f "$OUT/WebDriverAgentRunner-Runner.zip"
zip -qr "$OUT/WebDriverAgentRunner-Runner.zip" WebDriverAgentRunner-Runner.app \
    -x "WebDriverAgentRunner-Runner.app/Frameworks/*"
echo "$WDA_TAG" > "$OUT/wda-version.txt"
ls -l "$OUT/WebDriverAgentRunner-Runner.zip"
