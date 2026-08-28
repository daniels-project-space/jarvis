#!/usr/bin/env sh
set -eu

# Official sherpa-onnx CPU streaming English model. Run once on the host before
# starting the container; the named Docker volume keeps it warm thereafter.
MODEL="sherpa-onnx-streaming-zipformer-en-2023-06-26"
ARCHIVE="$MODEL.tar.bz2"
ROOT="${1:-./models}"
mkdir -p "$ROOT"
test -d "$ROOT/zipformer-en" && exit 0
curl --fail --location --retry 3 \
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$ARCHIVE" \
  --output "/tmp/$ARCHIVE"
tar -xjf "/tmp/$ARCHIVE" -C "$ROOT"
mv "$ROOT/$MODEL" "$ROOT/zipformer-en"
rm -f "/tmp/$ARCHIVE"
