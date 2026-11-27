#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$DESKTOP_DIR/.." && pwd)"

if [[ "${1:-}" == "--verify-only" ]]; then
  for req in \
    "$SCRIPT_DIR/linux/debian/control.in" \
    "$SCRIPT_DIR/linux/debian/rules" \
    "$SCRIPT_DIR/linux/debian/install.in" \
    "$SCRIPT_DIR/linux/debian/links.in" \
    "$SCRIPT_DIR/linux/debian/distribution.ini" \
    "$SCRIPT_DIR/linux/debian/package-prefs.js" \
    "$SCRIPT_DIR/linux/debian/lm-sanctuary.desktop" \
    "$SCRIPT_DIR/linux/rpm/firefox.spec.j2" \
    "$SCRIPT_DIR/linux/rpm/distribution.ini" \
    "$SCRIPT_DIR/linux/rpm/package-prefs.js" \
    "$SCRIPT_DIR/linux/rpm/lm-sanctuary.desktop" \
    "$SCRIPT_DIR/linux/appimage/AppRun" \
    "$SCRIPT_DIR/linux/appimage/lm-sanctuary.desktop"
  do
    test -f "$req"
  done
  echo "LINUX_PACKAGING_VERIFIED"
  exit 0
fi

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <tarball> <version> <build-number> [out-dir]" >&2
  exit 1
fi

tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
version="$2"
build_number="$3"
out_dir="${4:-$DESKTOP_DIR/dist}"
mkdir -p "$out_dir"
out_dir="$(cd "$out_dir" && pwd)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$DESKTOP_DIR/build/firefox"
./mach --no-interactive repackage deb \
  --input "$tarball" --output "$out_dir/lm-sanctuary_${version}-${build_number}_amd64.deb" \
  --arch x86_64 --version "$version" --build-number "$build_number" \
  --templates "$SCRIPT_DIR/linux/debian" --product lm-sanctuary --release-type release

mkdir -p "$work/langpacks" "$work/upload"
UPLOAD_DIR="$work/upload" ./mach --no-interactive repackage rpm \
  --input "$tarball" --input-xpi-dir "$work/langpacks" \
  --output "$out_dir/lm-sanctuary-${version}-${build_number}.x86_64.rpm" \
  --arch x86_64 --version "$version" --build-number "$build_number" \
  --templates "$SCRIPT_DIR/linux/rpm" --product lm-sanctuary --release-type release

if command -v appimagetool >/dev/null 2>&1; then
  appdir="$work/LM-Sanctuary.AppDir"
  mkdir -p "$appdir/usr/lib/lm-sanctuary" "$appdir/usr/share/applications" "$appdir/usr/share/icons/hicolor/128x128/apps"
  tar -xf "$tarball" -C "$appdir/usr/lib/lm-sanctuary" --strip-components=1
  install -m 0755 "$SCRIPT_DIR/linux/appimage/AppRun" "$appdir/AppRun"
  install -m 0644 "$SCRIPT_DIR/linux/appimage/lm-sanctuary.desktop" "$appdir/lm-sanctuary.desktop"
  install -m 0644 "$REPO_ROOT/web/assets/img/app_icon.png" "$appdir/lm-sanctuary.png"
  cp -f "$appdir/lm-sanctuary.png" "$appdir/.DirIcon"
  appimagetool "$appdir" "$out_dir/LM-Sanctuary-Browser-${version}-x86_64.AppImage"
fi
