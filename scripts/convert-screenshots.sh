#!/usr/bin/env bash
# Converts the screenshots for the README to WebP.
#
# Put PNG screenshots in docs/images/raw/ (not committed), named as the README expects, for example
# graph-dark.png. Each becomes docs/images/<name>.webp, at most 1600 px wide, with metadata stripped.
# Needs ImageMagick 7 (`magick`) built with WebP support.
#
# Usage: scripts/convert-screenshots.sh [FILE.png ...]   (default: every PNG in docs/images/raw/)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW="$ROOT/docs/images/raw"
OUT="$ROOT/docs/images"

command -v magick >/dev/null || { echo "ImageMagick 7 (magick) is not installed." >&2; exit 1; }
magick -list format | grep -q '^ *WEBP' || { echo "This ImageMagick can't write WebP." >&2; exit 1; }

if [ "$#" -gt 0 ]; then files=("$@"); else shopt -s nullglob; files=("$RAW"/*.png); fi
[ "${#files[@]}" -gt 0 ] || { echo "No PNG files in $RAW." >&2; exit 1; }

for png in "${files[@]}"; do
	webp="$OUT/$(basename "${png%.*}").webp"
	# Quality 90 keeps code and labels sharp; method 6 is the slowest, smallest encoding
	magick "$png" -strip -resize '1600x>' -quality 90 -define webp:method=6 "$webp"
	printf '%-40s %8s -> %8s\n' "$(basename "$png")" "$(du -h "$png" | cut -f1)" "$(du -h "$webp" | cut -f1)"
done
