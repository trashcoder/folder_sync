#!/bin/bash
set -e

VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
OUTPUT="build/foldersync-${VERSION}.xpi"

rm -f "$OUTPUT"

zip -r "$OUTPUT" \
  manifest.json \
  background.js \
  LICENSE \
  icons/ \
  popup/ \
  options/ \
  _locales/ \
  -x "*.DS_Store"

echo "Built: $OUTPUT"
