#!/bin/sh
# Builds the sk_notes APK: dist/sk_notes-<version>.apk
# Copyright (C) 2026 Enrico Miot
# SPDX-License-Identifier: GPL-3.0-or-later
#
# No Gradle: the web part is bundled with esbuild, the small native part is compiled with
# javac and the Android build tools (aapt2, d8, zipalign, apksigner).
#
#   sh build.sh            release build
#   sh build.sh --dev      web part not minified, with source maps
#
# Needs: node (and `npm ci` in the repository root), a JDK (17 or newer), the Android SDK
# with build-tools and one platform. Where to find it and how to sign:
#   ANDROID_HOME / ANDROID_SDK_ROOT   the SDK (default ~/android-sdk)
#   SKN_KEYSTORE                      keystore to sign with (default ~/.config/sk_notes-android/release.jks,
#                                     created on the first build). Its password is read from
#                                     SKN_KEYSTORE_PASS or from the file <keystore>.pass
# Keep the keystore: Android installs an update only if it is signed with the same key.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}
MIN_SDK=26
TARGET_SDK=35
DEV=""
[ "${1:-}" = "--dev" ] && DEV="--dev"

latest() { ls -1 "$1" 2>/dev/null | sort -V | tail -n 1; }
BT_VERSION=$(latest "$SDK/build-tools")
PLATFORM=$(latest "$SDK/platforms")
[ -n "$BT_VERSION" ] && [ -n "$PLATFORM" ] || { echo "Android SDK not found in $SDK (set ANDROID_HOME)" >&2; exit 1; }
BT="$SDK/build-tools/$BT_VERSION"
JAR="$SDK/platforms/$PLATFORM/android.jar"
[ -f "$JAR" ] || { echo "missing $JAR" >&2; exit 1; }
for tool in node javac keytool; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing program: $tool" >&2; exit 1; }
done
[ -x ../node_modules/.bin/esbuild ] || { echo "run 'npm ci' in the repository root first" >&2; exit 1; }

VERSION=$(node -p "require('./package.json').version")
# 0.5.0 → 500, 1.2.3 → 10203
CODE=$(echo "$VERSION" | awk -F. '{ printf "%d", $1 * 10000 + $2 * 100 + $3 }')
OUT="$HERE/build"
APK="$HERE/dist/sk_notes-$VERSION.apk"

echo "== web part"
node build-web.mjs $DEV

echo "== resources"
rm -rf "$OUT/res.zip" "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT/unsigned.apk" "$OUT/aligned.apk"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex" "$HERE/dist"
"$BT/aapt2" compile --dir app/res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "$JAR" --manifest app/AndroidManifest.xml \
  --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK" --version-code "$CODE" --version-name "$VERSION" \
  -A "$OUT/assets" --java "$OUT/gen" "$OUT/res.zip"

echo "== native part"
# Java 8 language level against the Android classes (never the JDK's own)
find app/java "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac -source 8 -target 8 -encoding UTF-8 -Xlint:-options \
  -bootclasspath "$JAR" -classpath "$BT/core-lambda-stubs.jar" -d "$OUT/classes" @"$OUT/sources.txt"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --release --min-api "$MIN_SDK" --lib "$JAR" --output "$OUT/dex" @"$OUT/classes.txt"

echo "== package"
(cd "$OUT/dex" && zip -q -j "$OUT/unsigned.apk" classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

KEYSTORE=${SKN_KEYSTORE:-$HOME/.config/sk_notes-android/release.jks}
if [ ! -f "$KEYSTORE" ]; then
  echo "== new signing key: $KEYSTORE (keep it, with $KEYSTORE.pass: updates need the same key)"
  mkdir -p "$(dirname "$KEYSTORE")"
  chmod 700 "$(dirname "$KEYSTORE")"
  (umask 077 && head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > "$KEYSTORE.pass")
  keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -storepass:file "$KEYSTORE.pass" -alias sk_notes \
    -keyalg RSA -keysize 4096 -validity 20000 -dname "CN=sk_notes, O=Skorpion OS" >/dev/null
  chmod 600 "$KEYSTORE"
fi
if [ -n "${SKN_KEYSTORE_PASS:-}" ]; then
  SKN_KEYSTORE_PASS="$SKN_KEYSTORE_PASS" "$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass env:SKN_KEYSTORE_PASS --out "$APK" "$OUT/aligned.apk"
else
  [ -f "$KEYSTORE.pass" ] || { echo "no password for $KEYSTORE: set SKN_KEYSTORE_PASS or write $KEYSTORE.pass" >&2; exit 1; }
  "$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass "file:$KEYSTORE.pass" --out "$APK" "$OUT/aligned.apk"
fi
rm -f "$APK.idsig"
"$BT/apksigner" verify --min-sdk-version "$MIN_SDK" "$APK"
echo "built $APK ($(du -h "$APK" | cut -f1))"
