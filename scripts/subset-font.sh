#!/usr/bin/env bash
# Regenerates the IBM Plex Mono subsets embedded in the terminal card.
#
# The card is rendered as an SVG, and GitHub serves README images through a
# sandbox that will not load external fonts. The typeface therefore has to be
# carried inside the file as a base64 data URI, which makes the full Latin
# subset (~35 KB per weight) too heavy to inline on every commit.
#
# So the glyphs are cut down to the characters the card actually prints, which
# takes each weight from ~17 KB to ~2 KB. Run this only when the card's
# character set changes:
#
#   FORCE_COLOR=0 pnpm dlx abdulkareem | tr -d '\n' > /tmp/chars.txt
#   scripts/subset-font.sh "$(cat /tmp/chars.txt)"
#
# Requires fonttools with brotli support:  uv pip install fonttools brotli

set -euo pipefail

CHARS="${1:?usage: subset-font.sh <character set>}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/profile/fonts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

npm pack @ibm/plex-mono@2.5.0 --pack-destination "$WORK" >/dev/null
tar xzf "$WORK"/ibm-plex-mono-2.5.0.tgz -C "$WORK"

mkdir -p "$OUT_DIR"

for weight in Regular SemiBold; do
  # Latin1 covers U+0020-007E plus the punctuation the card uses; the subsets
  # are already small, so re-subsetting trims the unused Latin-1 letters.
  src="$WORK/package/fonts/split/woff2/IBMPlexMono-${weight}-Latin1.woff2"
  pyftsubset "$src" \
    --text="$CHARS" \
    --flavor=woff2 \
    --layout-features='' \
    --no-hinting \
    --desubroutinize \
    --output-file="$OUT_DIR/IBMPlexMono-${weight}.woff2"
  printf '%s  %s bytes\n' "$weight" "$(wc -c <"$OUT_DIR/IBMPlexMono-${weight}.woff2")"
done

echo "wrote $OUT_DIR"