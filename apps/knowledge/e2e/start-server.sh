#!/bin/sh
# Fresh local D1 state (Knowledge + ultra-easy mock) and a dev server for E2E.
set -e
cd "$(dirname "$0")/.."
export KNOWLEDGE_PERSIST_PATH=".wrangler/e2e"
rm -rf "$KNOWLEDGE_PERSIST_PATH"
npx wrangler d1 migrations apply KNOWLEDGE_DB --local --persist-to "$KNOWLEDGE_PERSIST_PATH"
npx wrangler d1 migrations apply ULTRA_EASY_MOCK_DB --local --persist-to "$KNOWLEDGE_PERSIST_PATH"
exec ../../node_modules/.bin/vp dev --port "${KNOWLEDGE_E2E_PORT:-3101}" --strictPort
