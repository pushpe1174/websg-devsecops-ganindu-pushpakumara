#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run build

rm -rf build
mkdir -p build
cp -R dist/* build/
echo '{"type":"module"}' > build/package.json

echo "Packaged $(find build -name '*.js' | wc -l | tr -d ' ') file(s) into lambda/build"
