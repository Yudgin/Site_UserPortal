#!/usr/bin/env bash
# Страж выпуска портала my.runferry.com (проект droidmaps-runferry). Только читает: git, Cloud Run, Firestore, хостинг.
# Запускать из корня репозитория на ветке выпуска ПЕРЕД любой командой выпуска (docs/service-requirements.md §39).
#
#   scripts/portal-release-guard.sh [--new-env A,B] [--optional-env C,D] [--rules] [--indexes] [--allow-tag TAG]
#
#   --new-env       имена переменных, которые этот выпуск задаёт (--update-env-vars / --update-secrets)
#   --optional-env  имена, добавленные в server/.env.example, которые в бою сознательно не задаются
#   --rules         выпуск меняет правила Firestore (иначе разница правил — отказ)
#   --indexes       выпуск выкладывает индексы Firestore (тогда в бою не должно быть индексов, которых нет в файле)
#   --allow-tag     проверка уже выложенной этим выпуском ревизии-кандидата под тегом TAG (шаг перед переводом трафика)
#
# Ответ: «МОЖНО» и код 0, или «НЕЛЬЗЯ» со списком причин и код 1. Вход gcloud: обычный `gcloud auth login`;
# если он истёк, можно задать CLOUDSDK_AUTH_ACCESS_TOKEN_FILE на файл с токеном (файл после проверки удалить).
set -uo pipefail

PROJECT=droidmaps-runferry
REGION=europe-west3
SERVICE=runferry-backend
SITE=droidmaps-runferry

NEW_ENV=""; OPT_ENV=""; WANT_RULES=0; WANT_INDEXES=0; ALLOW_TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new-env) NEW_ENV="${2:-}"; shift 2 ;;
    --optional-env) OPT_ENV="${2:-}"; shift 2 ;;
    --rules) WANT_RULES=1; shift ;;
    --indexes) WANT_INDEXES=1; shift ;;
    --allow-tag) ALLOW_TAG="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 2 ;;
  esac
done

FAIL=()
WARN=()
fail() { FAIL+=("$1"); }
warn() { WARN+=("$1"); }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

cd "$(git rev-parse --show-toplevel)" || { echo "Не git-репозиторий" >&2; exit 2; }

# ---------- 1. Git ----------
git fetch -q origin --prune || fail "git fetch не прошёл — нет связи с GitHub"
BRANCH=$(git branch --show-current)
# Новейшая deploy-ветка, не считая саму ветку выпуска (после push она тоже лежит в origin/deploy/*).
NEWEST=$(git for-each-ref --sort=-committerdate --format='%(refname:short)' 'refs/remotes/origin/deploy/' | grep -vx "origin/${BRANCH:-<none>}" | head -1)
echo "Ветка выпуска:        ${BRANCH:-<нет, HEAD отсоединён>} @ $(git rev-parse --short HEAD)"
echo "Новейшая deploy:      ${NEWEST:-<нет>} @ $(git rev-parse --short "${NEWEST:-HEAD}" 2>/dev/null)"
if [[ -z "$NEWEST" ]]; then
  fail "не найдено ни одной ветки origin/deploy/*"
elif ! git merge-base --is-ancestor "$NEWEST" HEAD; then
  fail "в HEAD нет новейшей deploy-ветки $NEWEST — слейте её (git merge $NEWEST) и прогоните тесты"
fi
if [[ ! "$BRANCH" =~ ^deploy/backend-[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+$ ]]; then
  fail "ветка выпуска должна называться deploy/backend-ГГГГ-ММ-ДД-<имя>, сейчас: ${BRANCH:-<нет>}"
fi
if [[ -n "$(git status --porcelain)" ]]; then
  fail "в рабочей папке есть незакоммиченное или неотслеживаемое (gcloud --source отправит и его):"$'\n'"$(git status --porcelain | head -10)"
fi
if [[ -z "$(git branch -r --contains HEAD 2>/dev/null)" ]]; then
  fail "HEAD не отправлен на GitHub — выпускаем только то, что потом можно найти (git push -u origin $BRANCH)"
fi

# ---------- 2. Cloud Run ----------
if ! gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format=json > "$TMP/svc.json" 2> "$TMP/svc.err"; then
  echo; echo "НЕЛЬЗЯ: не прочитать Cloud Run ($(head -1 "$TMP/svc.err")). Войдите: gcloud auth login" ; exit 1
fi
SERVING=$(python3 - "$TMP/svc.json" "$ALLOW_TAG" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); allow=sys.argv[2]
st=d['status']; tr=st.get('traffic',[])
serving=[t for t in tr if t.get('percent',0)>0]
tags=[t for t in tr if t.get('tag')]
out=[]
if len(serving)!=1 or serving[0].get('percent')!=100:
    out.append('FAIL трафик разделён: '+', '.join(f"{t.get('revisionName')}={t.get('percent')}%" for t in serving))
srv=serving[0]['revisionName'] if serving else ''
other_tags=[t for t in tags if t.get('tag')!=allow]
if other_tags:
    out.append('FAIL на сервисе висит тег: '+', '.join(f"{t['tag']}→{t.get('revisionName')}" for t in other_tags)+' — идёт чужой выпуск или остался кандидат; снять тег можно только узнав, чей он')
cand=[t['revisionName'] for t in tags if allow and t.get('tag')==allow]
latest=st.get('latestCreatedRevisionName','')
if allow:
    if not cand: out.append(f'FAIL тега {allow} на сервисе нет')
    elif latest!=cand[0]: out.append(f'FAIL последняя созданная ревизия {latest}, а под тегом {allow} — {cand[0]}')
elif latest!=srv:
    out.append(f'FAIL последняя созданная ревизия {latest} ≠ ревизии с трафиком {srv}: новая ревизия унаследует переменные с {latest}')
if st.get('latestReadyRevisionName')!=latest:
    out.append(f"FAIL последняя созданная ревизия {latest} не готова (готова {st.get('latestReadyRevisionName')})")
print('SERVING '+srv)
print('CAND '+(cand[0] if cand else ''))
for o in out: print(o)
PY
)
SRV=$(sed -n 's/^SERVING //p' <<<"$SERVING")
CAND=$(sed -n 's/^CAND //p' <<<"$SERVING")
while IFS= read -r l; do [[ "$l" == FAIL\ * ]] && fail "${l#FAIL }"; done <<<"$SERVING"
echo "Ревизия с трафиком:   ${SRV:-<нет>}  (точка отката)"
[[ -n "$CAND" ]] && echo "Кандидат под тегом:   $CAND ($ALLOW_TAG)"

# ---------- 3. Переменные ----------
envnames() { # $1 = ревизия → имена переменных, по одному в строке
  gcloud run revisions describe "$1" --project "$PROJECT" --region "$REGION" --format=json 2>/dev/null \
  | python3 -c 'import json,sys;[print(e["name"]) for e in json.load(sys.stdin)["spec"]["containers"][0].get("env",[])]' | sort -u
}
exnames() { grep -oE '^#? *[A-Z][A-Z0-9_]*=' | sed 's/[# =]//g' | sort -u; }
if [[ -n "$SRV" ]]; then
  envnames "$SRV" > "$TMP/live.txt"
  echo "Переменных в бою:     $(wc -l < "$TMP/live.txt" | tr -d ' ')"
  [[ -s "$TMP/live.txt" ]] || fail "не удалось прочитать переменные ревизии $SRV"
  python3 -c 'import json,sys;[print(e["name"]) for e in json.load(open(sys.argv[1]))["spec"]["template"]["spec"]["containers"][0].get("env",[])]' "$TMP/svc.json" | sort -u > "$TMP/tmpl.txt"
  if [[ -z "$ALLOW_TAG" ]] && ! cmp -s "$TMP/live.txt" "$TMP/tmpl.txt"; then
    fail "имена переменных шаблона сервиса ≠ ревизии с трафиком: только в шаблоне [$(comm -13 "$TMP/live.txt" "$TMP/tmpl.txt" | tr '\n' ' ')], только в бою [$(comm -23 "$TMP/live.txt" "$TMP/tmpl.txt" | tr '\n' ' ')]"
  fi
  git show "HEAD:server/.env.example" 2>/dev/null | exnames > "$TMP/ex_head.txt"
  git show "$NEWEST:server/.env.example" 2>/dev/null | exnames > "$TMP/ex_newest.txt"
  MISSING=$(comm -23 "$TMP/live.txt" "$TMP/ex_head.txt" | tr '\n' ' ')
  [[ -n "${MISSING// }" ]] && fail "в бою есть переменные, которых нет в server/.env.example: [$MISSING] — допишите имена (без значений)"
  tr ',' '\n' <<<"$NEW_ENV,$OPT_ENV" | sed '/^$/d' | sort -u > "$TMP/declared.txt"
  ADDED=$(comm -23 "$TMP/ex_head.txt" "$TMP/ex_newest.txt" | comm -23 - "$TMP/live.txt" | comm -23 - "$TMP/declared.txt" | tr '\n' ' ')
  [[ -n "${ADDED// }" ]] && fail "ветка добавила в .env.example имена, которых нет в бою: [$ADDED] — перечислите их в --new-env (задаём) или --optional-env (сознательно не задаём)"
  if [[ -n "$NEW_ENV" ]]; then
    for v in $(tr ',' ' ' <<<"$NEW_ENV"); do grep -qx "$v" "$TMP/ex_head.txt" || fail "--new-env $v: имени нет в server/.env.example"; done
  fi
  if [[ -n "$CAND" ]]; then
    envnames "$CAND" > "$TMP/cand.txt"
    { cat "$TMP/live.txt"; tr ',' '\n' <<<"$NEW_ENV" | sed '/^$/d'; } | sort -u > "$TMP/expect.txt"
    cmp -s "$TMP/cand.txt" "$TMP/expect.txt" || fail "переменные кандидата ≠ бой + --new-env: лишние [$(comm -13 "$TMP/expect.txt" "$TMP/cand.txt" | tr '\n' ' ')], потеряны [$(comm -23 "$TMP/expect.txt" "$TMP/cand.txt" | tr '\n' ' ')]"
  fi
fi

# ---------- 4. Firestore: правила и индексы (из HEAD, не из рабочей папки) ----------
git show HEAD:firestore.rules > "$TMP/head.rules" 2>/dev/null
git show HEAD:firestore.indexes.json > "$TMP/head.idx.json" 2>/dev/null
TOKEN=$(gcloud auth print-access-token 2>/dev/null || true)
H=(-s -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT")
RS=$(curl "${H[@]}" "https://firebaserules.googleapis.com/v1/projects/$PROJECT/releases/cloud.firestore" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("rulesetName",""))' 2>/dev/null)
if [[ -n "$RS" ]]; then
  curl "${H[@]}" "https://firebaserules.googleapis.com/v1/$RS" | python3 -c 'import json,sys;[sys.stdout.write(f["content"]) for f in json.load(sys.stdin)["source"]["files"]]' > "$TMP/live.rules" 2>/dev/null
  if cmp -s "$TMP/live.rules" "$TMP/head.rules"; then
    echo "Правила Firestore:    совпадают с боем"
  elif [[ $WANT_RULES -eq 1 ]]; then
    warn "выпуск меняет правила Firestore: $(diff "$TMP/live.rules" "$TMP/head.rules" | grep -c '^[<>]') строк разницы — показать: diff <(живые) firestore.rules"
  else
    fail "firestore.rules в ветке ≠ правил в бою, а --rules не задан (выпуск правил не заявлен)"
  fi
else
  warn "не удалось прочитать живые правила Firestore — сверьте вручную"
fi
if gcloud firestore indexes composite list --project "$PROJECT" --format=json > "$TMP/idx.json" 2>/dev/null; then
  NOTINFILE=$(python3 - "$TMP/idx.json" "$TMP/head.idx.json" <<'PY'
import json,sys
live=json.load(open(sys.argv[1])); f=json.load(open(sys.argv[2]))
key=lambda cg,fs:(cg,tuple((x['fieldPath'],x.get('order') or x.get('arrayConfig')) for x in fs if x['fieldPath']!='__name__'))
F={key(i['collectionGroup'],i['fields']) for i in f.get('indexes',[])}
for i in live:
    cg=i['name'].split('/collectionGroups/')[1].split('/')[0]
    k=key(cg,i['fields'])
    if k not in F: print(cg+'('+','.join(x[0] for x in k[1])+')')
PY
)
  if [[ -n "$NOTINFILE" ]]; then
    if [[ $WANT_INDEXES -eq 1 ]]; then fail "в бою есть индексы, которых нет в firestore.indexes.json: $NOTINFILE — их удалит выпуск индексов; сначала впишите их в файл"
    else warn "в бою есть индексы не из файла: $NOTINFILE (индексы не выпускаем — не страшно)"; fi
  fi
else
  warn "не удалось прочитать индексы Firestore"
fi

# ---------- 5. Хостинг ----------
HV=$(curl "${H[@]}" "https://firebasehosting.googleapis.com/v1beta1/sites/$SITE/channels/live" | python3 -c 'import json,sys;print(json.load(sys.stdin)["release"]["version"]["name"].split("/")[-1])' 2>/dev/null)
echo "Хостинг в бою:        ${HV:-<не прочитан>}  (точка отката)"

# ---------- Итог ----------
echo
for w in "${WARN[@]+"${WARN[@]}"}"; do echo "ВНИМАНИЕ: $w"; done
if [[ ${#FAIL[@]} -gt 0 ]]; then
  echo "НЕЛЬЗЯ выпускать:"; for f in "${FAIL[@]}"; do echo " - $f"; done; exit 1
fi
echo "МОЖНО. Откат: трафик на ${SRV}, хостинг ${HV:-?}. Дальше — команды из docs §39, без --env-vars-file / --set-*."
