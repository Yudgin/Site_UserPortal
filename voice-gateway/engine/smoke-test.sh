#!/usr/bin/env bash
# Локальний димовий тест sip-engine без Binotel: усе тільки на 127.0.0.1 (рушій :5092, pjsua P1 :5091 і P2 :5093,
# сирий SIP :5095, фальшивий реєстратор :5096). Журнали — у voice-gateway/engine/.smoke/ (або $WORK).
# Рушій — $ENGINE (типово ./sip-engine). Поки шлюз працює зі старим sip-engine, перевіряйте новий під іншим ім'ям:
#   ENGINE="$PWD/voice-gateway/engine/sip-engine-ai" voice-gateway/engine/smoke-test.sh
# (рушій із цієї теки скрипт збирає його власною ціллю make: sip-engine-ai не чіпає sip-engine / sip-engine-next живого шлюзу).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export WORK="${WORK:-$HERE/.smoke}"
export PJSUA="${PJSUA:-/opt/homebrew/bin/pjsua}"
export ENGINE="${ENGINE:-$HERE/sip-engine}"

case "$ENGINE" in
  "$HERE"/sip-engine | "$HERE"/sip-engine-next | "$HERE"/sip-engine-ai) make -C "$HERE" --no-print-directory "$(basename "$ENGINE")" ;;
  *) [ -x "$ENGINE" ] || { echo "нет движка: $ENGINE" >&2; exit 2; } ;;
esac
echo "движок: $ENGINE"
[ -x "$PJSUA" ] || { echo "немає pjsua: $PJSUA" >&2; exit 2; }
for port in 5091 5092 5093 5095 5096; do
  if lsof -nP -iUDP@127.0.0.1:$port >/dev/null 2>&1; then echo "UDP-порт 127.0.0.1:$port зайнятий" >&2; exit 2; fi
done
rm -rf "$WORK"
mkdir -p "$WORK"
exec node "$HERE/smoke-test.mjs"
