#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec "${NODE_PATH:-node}" start-local.js
