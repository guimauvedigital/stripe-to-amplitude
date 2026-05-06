#!/usr/bin/env bash
# Convenience script for a local end-to-end run on your Mac.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo ".env missing — copy .env.example and fill it in first." >&2
  exit 1
fi

pnpm install
pnpm --filter @stripe-to-amplitude/core build
pnpm --filter @stripe-to-amplitude/backfill build

echo "------ DRY RUN ------"
DRY_RUN=1 pnpm backfill

read -rp "Looks good? Hit Enter to do the real import, Ctrl-C to abort. "
pnpm backfill
