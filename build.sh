#!/bin/bash
set -e

VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

# Increment build number
BUILD=$(grep -o 'BUILD_NUMBER = [0-9]*' build_info.js | grep -o '[0-9]*')
BUILD=$((BUILD + 1))
echo "const BUILD_NUMBER = $BUILD;" > build_info.js

OUTPUT="build/foldersync-${VERSION}.xpi"

rm -f "$OUTPUT"

zip -r "$OUTPUT" \
  manifest.json \
  folder-resolver.js \
  background.js \
  build_info.js \
  LICENSE \
  icons/ \
  popup/ \
  options/ \
  _locales/ \
  -x "*.DS_Store"

echo "Built: $OUTPUT (build $BUILD)"
