#!/usr/bin/env bash
# Downloads the latest stable Cursor for Linux x64 from Cursor's download API and extracts its AppImage, so that
# the E2E tests can launch it through FUSEN_E2E_EXECUTABLE_PATH.
#
# Usage:
#   download-cursor.sh <out-dir>
#
# The AppImage is extracted with its own --appimage-extract, which needs no FUSE (GitHub's Ubuntu runners have none),
# into <out-dir>/<version>.
#
# Output on stdout, one key=value per line (the format of $GITHUB_OUTPUT):
#   version, commit, executable-path
# Progress goes to stderr.
#
# Exit codes:
#   0  the executable is ready
#   1  the download API, the download or the extraction failed, or the extracted AppImage has no executable
#   2  invalid arguments
#
# Idempotent: a version whose extraction directory exists is not downloaded again; the directory is created only
# after a complete extraction.
# Requires curl and jq, and Linux x64 to run the AppImage.
set -euo pipefail

# The endpoint behind the Linux download button of https://cursor.com/downloads; it answers the newest stable build.
readonly download_api_url="https://cursor.com/api/download?platform=linux-x64&releaseTrack=stable"
# The Electron binary inside the AppImage. AppRun only wraps it, and Playwright needs the binary itself.
readonly executable_relative_path="usr/share/cursor/cursor"

if [ $# -ne 1 ]; then
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
# Absolute, because the executable path is printed for use from other working directories.
out_dir="$(mkdir -p "$1" && cd "$1" && pwd)"

release_json="$(curl -fsSL "$download_api_url")" || { echo "error: $download_api_url failed" >&2; exit 1; }
version="$(jq -r '.version // empty' <<<"$release_json")"
commit="$(jq -r '.commitSha // empty' <<<"$release_json")"
appimage_url="$(jq -r '.downloadUrl // empty' <<<"$release_json")"
if [ -z "$version" ] || [ -z "$appimage_url" ]; then
  echo "error: unexpected response from $download_api_url: $release_json" >&2
  exit 1
fi
echo "Cursor $version (commit $commit): $appimage_url" >&2

dir="$out_dir/$version"
if [ -d "$dir" ]; then
  echo "$dir already has Cursor $version; skipping the download" >&2
else
  partial_dir="$dir.partial"
  rm -rf "$partial_dir"
  mkdir -p "$partial_dir"
  curl -fsSL -o "$partial_dir/Cursor.AppImage" "$appimage_url" || { echo "error: downloading $appimage_url failed" >&2; exit 1; }
  chmod +x "$partial_dir/Cursor.AppImage"
  # --appimage-extract writes squashfs-root into the working directory.
  (cd "$partial_dir" && ./Cursor.AppImage --appimage-extract >/dev/null) || { echo "error: extracting the AppImage failed" >&2; exit 1; }
  rm -f "$partial_dir/Cursor.AppImage"
  mv "$partial_dir" "$dir"
fi

executable_path="$dir/squashfs-root/$executable_relative_path"
if [ ! -x "$executable_path" ]; then
  echo "error: $executable_path is not in the AppImage; its executables are:" >&2
  find "$dir/squashfs-root" -maxdepth 4 -type f -perm -u+x >&2
  exit 1
fi

echo "version=$version"
echo "commit=$commit"
echo "executable-path=$executable_path"
