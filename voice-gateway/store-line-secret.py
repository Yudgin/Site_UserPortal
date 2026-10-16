#!/usr/bin/env python3
# Зберегти облікові дані лінії Binotel у Secret Manager (проєкт droidmaps-runferry), щоб шлюз брав їх сам:
#   BINOTEL_LINE_SECRET=binotel-line-901 node voice-gateway/brain/gateway.mjs
# Логін і пароль вводить власник (пароль не відображається); скрипт нічого не друкує й не пише на диск.
# Доступ — токен ADC (gcloud auth application-default login).
import base64, getpass, json, subprocess, sys, urllib.error, urllib.request

PROJECT = 'droidmaps-runferry'
NAME = sys.argv[1] if len(sys.argv) > 1 else 'binotel-line-901'
API = f'https://secretmanager.googleapis.com/v1/projects/{PROJECT}/secrets'


def call(method, url, body=None):
    tok = subprocess.check_output(['gcloud', 'auth', 'application-default', 'print-access-token'], text=True).strip()
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
                                          'x-goog-user-project': PROJECT})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, {}


server = input('SIP-сервер [sip14.binotel.com]: ').strip() or 'sip14.binotel.com'
user = input('Логін лінії (SIP): ').strip()
password = getpass.getpass('Пароль лінії (не відображається): ')
if not user or not password:
    sys.exit('логін і пароль обовʼязкові — нічого не збережено')

status, _ = call('POST', f'{API}?secretId={NAME}', {'replication': {'automatic': {}},
                                                     'labels': {'purpose': 'voice-gateway'}})
if status not in (200, 409):
    sys.exit(f'не вдалося створити секрет {NAME} (HTTP {status}) — нічого не збережено')
payload = base64.b64encode(json.dumps({'server': server, 'user': user, 'password': password}).encode()).decode()
status, res = call('POST', f'{API}/{NAME}:addVersion', {'payload': {'data': payload}})
password = payload = None
if status != 200:
    sys.exit(f'не вдалося зберегти версію (HTTP {status})')
print(f'збережено: {NAME}, версія {res.get("name", "?").rsplit("/", 1)[-1]}')
