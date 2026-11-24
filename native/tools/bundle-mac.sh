#!/bin/bash
# Wraps a built binary into umakbang.app, then signs, zips and makes a disk image of it.
#
#   tools/bundle-mac.sh <binary> <arch label: arm64|x64> <out dir>
#
# Writes <out>/umakbang.app, <out>/umakbang-native-<version>-mac-<arch>.zip (what the updater
# installs) and <out>/umakbang-<version>-mac-<arch>.dmg (what a first install opens), with a
# .sha256 beside the zip. Run from native/.
#
# Signing happens when MAC_SIGN_IDENTITY names a keychain identity. It must be the Developer ID
# Application one: an installed copy refuses an update signed by anything else, even an
# `Apple Development` identity of the same team (see electron-builder.yml's mac block).
# Notarising happens when APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are set too.
set -euo pipefail

binary=$1
arch=$2
out=$3
version=$(grep -m1 '^version' Cargo.toml | cut -d'"' -f2)
# Kept from the Electron app, so an installed Electron copy can update into this one and
# macOS treats them as the same app (its permissions, its login item, its place in the Dock).
bundle_id=dev.umakbang.app

app="$out/umakbang.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/umakbang"
chmod 755 "$app/Contents/MacOS/umakbang"

# The icon, from the same 1024px master Electron used.
iconset=$(mktemp -d)/icon.iconset
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z $size $size ../build/icon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double ../build/icon.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/icon.icns"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>umakbang</string>
	<key>CFBundleDisplayName</key>
	<string>umakbang</string>
	<key>CFBundleIdentifier</key>
	<string>$bundle_id</string>
	<key>CFBundleExecutable</key>
	<string>umakbang</string>
	<key>CFBundleIconFile</key>
	<string>icon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$version</string>
	<key>LSApplicationCategoryType</key>
	<string>public.app-category.music</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
	<key>NSSupportsAutomaticGraphicsSwitching</key>
	<true/>
	<key>NSHumanReadableCopyright</key>
	<string>AGPL-3.0-only</string>
</dict>
</plist>
PLIST

if [ -n "${MAC_SIGN_IDENTITY:-}" ]; then
  # The hardened runtime is what notarisation requires; the app needs no exceptions to it.
  codesign --force --timestamp --options runtime --sign "$MAC_SIGN_IDENTITY" "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
else
  # Ad hoc: runs on the machine that built it, and on Apple silicon at all (unsigned arm64
  # code is refused outright). Gatekeeper still stops it elsewhere until it is opened from the
  # context menu.
  codesign --force --sign - "$app"
  echo "MAC_SIGN_IDENTITY not set: the app is signed ad hoc, not with a Developer ID."
fi

zip="$out/umakbang-native-$version-mac-$arch.zip"
rm -f "$zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"

if [ -n "${MAC_SIGN_IDENTITY:-}" ] && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  xcrun notarytool submit "$zip" --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
  xcrun stapler staple "$app"
  # Zipped again, so the copy the updater installs carries the stapled ticket.
  rm -f "$zip"
  ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
fi

# A disk image with the app and a link to Applications beside it, to drag across.
dmg="$out/umakbang-$version-mac-$arch.dmg"
stage=$(mktemp -d)
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
hdiutil create -volname "umakbang $version" -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null
if [ -n "${MAC_SIGN_IDENTITY:-}" ]; then
  codesign --force --timestamp --sign "$MAC_SIGN_IDENTITY" "$dmg"
fi

(cd "$out" && shasum -a 256 "$(basename "$zip")" > "$(basename "$zip").sha256" && cat "$(basename "$zip").sha256")
echo "Wrote $app, $zip and $dmg"
