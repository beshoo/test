#!/usr/bin/env bash
# Stamp a cache-busting version onto the scanner's own module URLs, so a browser
# or CDN (GitHub Pages, githack) never mixes a new index.html with an old cached
# scanner.js. Run after every change:  ./stamp-version.sh [version]
# Default version: the current git commit plus a timestamp.
set -euo pipefail
cd "$(dirname "$0")"
v="${1:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)-$(date +%Y%m%d%H%M)}"
stamp() { sed -i -E "s#(['\"]\./$2)(\?v=[^'\"]*)?(['\"])#\1?v=${v}\3#g" "$1"; }
stamp index.html scanner.js
stamp index.html gs1.js
stamp scanner.js engine/decode-core.js
stamp scanner.js engine/worker.js
stamp engine/worker.js decode-core.js
stamp engine/decode-core.js ean-grey.js
stamp scanner.js engine/grey-worker.js
stamp engine/grey-worker.js decode-core.js
stamp engine/grey-worker.js ean-grey.js
echo "stamped v=${v}"
grep -n "?v=" index.html scanner.js engine/worker.js
