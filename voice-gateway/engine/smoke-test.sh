#!/usr/bin/env bash
# Локальний димовий тест sip-engine без Binotel: усе тільки на 127.0.0.1 (рушій :5092, pjsua P1 :5091 і P2 :5093,
# сирий SIP :5095, фальшивий реєстратор :5096). Журнали — у voice-gateway/engine/.smoke/ (або $WORK).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export WORK="${WORK:-$HERE/.smoke}"
export PJSUA="${PJSUA:-/opt/homebrew/bin/pjsua}"

make -C "$HERE" --no-print-directory sip-engine
[ -x "$PJSUA" ] || { echo "немає pjsua: $PJSUA" >&2; exit 2; }
for port in 5091 5092 5093 5095 5096; do
  if lsof -nP -iUDP@127.0.0.1:$port >/dev/null 2>&1; then echo "UDP-порт 127.0.0.1:$port зайнятий" >&2; exit 2; fi
done
rm -rf "$WORK"
mkdir -p "$WORK"
exec node "$HERE/smoke-test.mjs"
