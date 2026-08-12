#!/usr/bin/env bash
# Produces lambda/build - the directory Terraform zips into the deployment package.
#
# Only compiled JS goes in: the Node.js 24 Lambda runtime ships the AWS SDK v3,
# so node_modules is not bundled. The package.json is required because the code
# is ESM - without "type": "module" the runtime would load index.js as CommonJS
# and the imports would fail at cold start.
set -euo pipefail

cd "$(dirname "$0")/.."

npm run build

rm -rf build
mkdir -p build
cp -R dist/* build/
echo '{"type":"module"}' > build/package.json

echo "Packaged $(find build -name '*.js' | wc -l | tr -d ' ') file(s) into lambda/build"
