#!/usr/bin/env python3
"""
AI Execute Runner — локальный сервер выполнения команд.
Слушает ТОЛЬКО 127.0.0.1:8765 (доступ лишь с вашего ПК).
Расширение для браузера шлёт сюда команды из ```execute-блоков.

Запуск:
    python server.py [--port 8765] [--cwd PATH] [--max-output N] [--verbose]

Зависимостей нет — только стандартная библиотека.
"""
import argparse
import base64
import hmac
import json
import mimetypes
import os
import platform
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '2.5.3.2'
MAX_OUTPUT = 1_000_000  # лимит stdout/stderr (меняется флагом --max-output, 0 = без лимита)
DEFAULT_TIMEOUT = 30
AUTH_TOKEN = None  # если задан - требуется заголовок X-Auth-Token для POST /run
LOG_FILE = None  # путь к файлу логов (None = только консоль)
RATE_LIMIT = 0  # N команд в минуту (0 = без лимита)
WHITELIST = None  # None = выключен; frozenset префиксов (lowercase) = включён
_WHITELIST_META = re.compile(r'[;&|<>`]|\$\(')  # shell-метасимволы

# Unicode-пробелы, которые чаты вставляют в code-блоки через &nbsp; и родственники.
# NBSP (U+00A0) — самый частый: Python падает с "SyntaxError: invalid non-printable
# character U+00A0", PowerShell — с "Invalid argument". Заменяем их на обычный пробел.
_UNICODE_SPACES_RE = re.compile(r'[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]')
# Невидимые модификаторы (zero-width space/joiner, word joiner, BOM) — удаляем совсем.
_ZERO_WIDTH_RE = re.compile(r'[\u200b-\u200d\u2060\ufeff]')


def normalize_whitespace(text):
    """Чистит код от NBSP и невидимых модификаторов, которые ломают парсеры.
    Применяется ко всем раннерам: python/node/powershell/shell."""
    if not text:
        return text
    text = _UNICODE_SPACES_RE.sub(' ', text)
    text = _ZERO_WIDTH_RE.sub('', text)
    return text

_rate_lock = threading.Lock()
_rate_times = []  # timestamps последних запусков (для rate limit)
VERBOSE = False  # True => логировать вообще всё, включая /ping

def _readable_score(s):
    """Эвристика «похожести на осмысленный текст» для выбора кодировки."""
    score = 0
    for ch in s:
        o = ord(ch)
        if ch in '\r\n\t' or 0x20 <= o < 0x7F:
            score += 2
        elif 0x410 <= o <= 0x44F or o in (0x401, 0x451, 0x2013, 0x2014, 0xAB, 0xBB):
            score += 3  # кириллица и русская пунктуация
        elif 0x2500 <= o <= 0x257F or 0x2580 <= o <= 0x259F:
            score += 2  # псевдографика консоли
    return score


def _decode_one_line(chunk):
    """Декодирует один фрагмент (строку) в наиболее правдоподобной кодировке.
    Windows даёт СМЕШАННЫЙ поток: внутренние команды cmd (echo, dir) пишут
    в OEM-кодировке (cp866), а node/python всегда пишут UTF-8. Единая
    кодировка на весь буфер гарантированно ломает половину строк."""
    # 1) Строгий UTF-8 — предпочтителен: node/python всегда шлют utf-8.
    try:
        s = chunk.decode('utf-8')
        if any(0x400 <= ord(c) <= 0x4FF for c in s):
            return s  # есть кириллица => это точно UTF-8
        alt866 = chunk.decode('cp866', errors='replace')
        if _readable_score(alt866) > _readable_score(s) + 4:
            return alt866
        return s
    except (UnicodeDecodeError, LookupError):
        pass
    # 2) Не UTF-8 — выбираем между cp866 и cp1251 по читаемости.
    cands = []
    for enc in ('cp866', 'cp1251'):
        try:
            t = chunk.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
        cands.append((_readable_score(t), t))
    if cands:
        cands.sort(key=lambda x: x[0], reverse=True)
        return cands[0][1]
    return chunk.decode('utf-8', errors='replace')


def smart_decode(data):
    """Декодируем вывод процесса.
    Быстрый путь — весь буфер как строгий UTF-8. Если не вышло (смешанный
    вывод cmd + node/python), разбиваем по переводам строк и декодируем
    каждую строку отдельно."""
    if not data:
        return ''
    if isinstance(data, str):
        return data
    try:
        return data.decode('utf-8')
    except (UnicodeDecodeError, LookupError):
        pass
    # Смешанный буфер: сохраняем разделители строк как есть.
    parts = re.split(rb'(\r\n|\n|\r)', data)
    out = []
    for chunk in parts:
        if not chunk:
            continue
        if chunk in (b'\r\n', b'\n', b'\r'):
            out.append(chunk.decode('ascii'))
            continue
        out.append(_decode_one_line(chunk))
    return ''.join(out)


def _win_short_path(p):
    """8.3-имя файла (C:\\Users\\MINECR~1\\...). Нужно, чтобы путь к .cmd
    гарантированно не содержал пробелов: иначе cmd.exe с `call "путь"` в
    некоторых комбинациях ключей не находит файл и команда молча падает."""
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(1024)
        if ctypes.windll.kernel32.GetShortPathNameW(p, buf, 1024):
            return buf.value or p
    except Exception:
        pass
    return p


def _run_shell_windows_multiline(command, timeout, cwd, env=None):
    """Многострочные команды для cmd.exe.
    shell=True передаёт весь текст одной строкой — cmd.exe читает ТОЛЬКО
    первую строку и молча теряет всё после первого \n. Поэтому пишем
    временный .cmd и запускаем файлом.

    Кодировка — cp866 (OEM-кодировка русской консоли), chcp 866 выполняется
    ДО `call`, чтобы cmd читал файл именно в cp866. При chcp 65001 кириллица
    из тела .cmd ломается («т_мир» вместо «Привет_мир») — проверено."""
    norm = command.replace('\r\n', '\n').replace('\r', '\n')
    with tempfile.NamedTemporaryFile('w', suffix='.cmd', delete=False,
                                     encoding='cp866', errors='replace', newline='') as f:
        f.write('@echo off\n' + norm + '\n')
        path = f.name
    try:
        # call + короткое имя без кавычек: кавычки вокруг пути cmd.exe
        # обрабатывает нестабильно (в части сборок Windows путь с кавычками
        # трактуется как имя файла с кавычками внутри).
        short = _win_short_path(path)
        return subprocess.run(['cmd', '/d', '/c', 'chcp 866 >nul && call ' + short],
                              capture_output=True, timeout=timeout, cwd=cwd or None, env=env)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def run_shell(command, timeout, cwd):
    """Shell: cmd.exe на Windows, bash (или sh) на Linux/Mac."""
    if os.name == 'nt':
        # Python при выводе в pipe по умолчанию берёт ANSI/OEM-кодировку консоли
        # и падает на кириллице (UnicodeEncodeError: 'charmap'). Эти две
        # переменные заставляют любой дочерний python писать UTF-8 независимо
        # от chcp. node и так всегда пишет UTF-8, ему ничего не нужно.
        env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
        # Многострочные команды — через .cmd-файл (см. _run_shell_windows_multiline).
        if '\n' in command:
            return _run_shell_windows_multiline(command, timeout, cwd, env)
        # Однострочные: chcp 65001 — чтобы внутренние команды cmd отдавали UTF-8
        # (кириллица не едет в ????).
        return subprocess.run('chcp 65001 >nul & ' + command, shell=True, capture_output=True,
                              timeout=timeout, cwd=cwd or None, env=env)
    bash = '/bin/bash' if os.path.exists('/bin/bash') else '/bin/sh'
    return subprocess.run(command, shell=True, capture_output=True,
                          timeout=timeout, cwd=cwd or None, executable=bash)

def run_with_tempfile(code, timeout, cwd, suffix, argv, encoding='utf-8', env=None):
    """Записать код во временный файл и выполнить интерпретатором."""
    with tempfile.NamedTemporaryFile('w', suffix=suffix, delete=False, encoding=encoding) as f:
        f.write(code)
        path = f.name
    try:
        return subprocess.run([*argv, path], capture_output=True,
                              timeout=timeout, cwd=cwd or None, env=env)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

def _clip(text):
    """Обрезка вывода по лимиту MAX_OUTPUT в БАЙТАХ (0 = без лимита).
    Оставляем НАЧАЛО (как клиентская обрезка) — предсказуемо для ИИ.
    Возвращает (text, truncated)."""
    if MAX_OUTPUT <= 0:
        return text, False
    data = text.encode('utf-8')
    if len(data) <= MAX_OUTPUT:
        return text, False
    return data[:MAX_OUTPUT].decode('utf-8', errors='ignore'), True


DEFAULT_WHITELIST_CONTENT = """# AI Execute Runner - whitelist
#
# Одна команда/префикс на строку. Строки, начинающиеся с #, игнорируются.
# Команда разрешена, если она РАВНА префиксу или начинается с "префикс + пробел".
# Пример: "ls" разрешит "ls", "ls -la", "ls /tmp", но НЕ "lsfoo".
#
# В whitelist-режиме ЗАПРЕЩЕНЫ shell-метасимволы: ; & | < > ` $(
# Если нужны пайпы/цепочки - запусти сервер без --whitelist или выполни вручную.
#
# Регистр не важен на Windows, важен на Linux/Mac (сравнение lowercase).

# --- файловая система: чтение ---
ls
dir
cat
type
head
tail
tree
pwd

# --- навигация ---
cd

# --- текст ---
echo
grep
find
where
which

# --- git: только чтение ---
git status
git log
git diff
git branch
git show

# --- языки: интерпретаторы ---
python
python3
node

# --- пакетные менеджеры: только инфо ---
npm list
npm test
npm run
pip list
pip show

# --- система: инфо ---
whoami
hostname
date
ver
uname
ipconfig
ifconfig

# --- PowerShell: чтение ---
Get-Content
Get-ChildItem
Get-Process
Get-Service
Get-Location
"""


def _load_whitelist(path):
    """Читает файл whitelist. Возвращает frozenset префиксов в lowercase.
    Если файла нет - создаёт с дефолтным содержимым и читает его же."""
    if not os.path.exists(path):
        try:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(DEFAULT_WHITELIST_CONTENT)
            _log(f'[whitelist] создан файл по умолчанию: {path}')
        except OSError as e:
            raise RuntimeError(f'cannot create whitelist: {e}')
    prefixes = set()
    with open(path, 'r', encoding='utf-8') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            prefixes.add(line.lower())
    return frozenset(prefixes)


def _check_whitelist(cmd):
    """Возвращает (ok: bool, reason: str).
    True - команда разрешена (или whitelist выключен)."""
    if WHITELIST is None:
        return True, ''
    c = (cmd or '').strip()
    if not c:
        return False, 'empty command'
    if _WHITELIST_META.search(c):
        return False, 'shell metacharacters (; & | < > ` $() not allowed in whitelist mode'
    cl = c.lower()
    for prefix in WHITELIST:
        if cl == prefix or cl.startswith(prefix + ' '):
            return True, ''
    # Первое слово для понятной ошибки
    first = cl.split()[0] if cl.split() else '?'
    return False, f'command not in whitelist (starts with: {first})'


def _log(msg):
    """Печатает в stdout и (если задан LOG_FILE) пишет с timestamp в файл."""
    try:
        sys.stdout.write(msg + '\n')
        sys.stdout.flush()
    except Exception:
        pass
    if LOG_FILE:
        try:
            ts = time.strftime('%Y-%m-%d %H:%M:%S')
            with open(LOG_FILE, 'a', encoding='utf-8') as f:
                f.write(f'[{ts}] {msg}\n')
        except OSError:
            pass


def _check_rate():
    """Проверяет rate limit. Возвращает (ok, wait_seconds)."""
    if RATE_LIMIT <= 0:
        return True, 0.0
    now = time.time()
    with _rate_lock:
        while _rate_times and now - _rate_times[0] > 60:
            _rate_times.pop(0)
        if len(_rate_times) >= RATE_LIMIT:
            wait = 60.0 - (now - _rate_times[0])
            return False, max(0.0, wait)
        _rate_times.append(now)
        return True, 0.0



# --- view: просмотр изображений ---
VIEW_MAX_BYTES = 10 * 1024 * 1024  # 10 MB
VIEW_MIMES = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
}

def _handle_view(raw_path):
    """Читает изображение и возвращает data URL. Shell не выполняет."""
    p = (raw_path or '').strip().strip('"').strip("'")
    if not p:
        return {'ok': False, 'executed': False, 'error': 'view: empty path'}
    p = os.path.expanduser(p)
    if not os.path.isabs(p):
        p = os.path.abspath(p)
    if not os.path.exists(p):
        return {'ok': False, 'executed': False, 'error': 'view: file not found: ' + p}
    if not os.path.isfile(p):
        return {'ok': False, 'executed': False, 'error': 'view: not a file: ' + p}
    ext = os.path.splitext(p)[1].lower()
    mime = VIEW_MIMES.get(ext)
    if not mime:
        mime = mimetypes.guess_type(p)[0] or ''
    if not mime.startswith('image/'):
        return {'ok': False, 'executed': False, 'error': 'view: not an image (ext=' + ext + ')'}
    size = os.path.getsize(p)
    if size > VIEW_MAX_BYTES:
        return {'ok': False, 'executed': False, 'error': 'view: file too large'}
    try:
        with open(p, 'rb') as fh:
            data = fh.read()
    except OSError as e:
        return {'ok': False, 'executed': False, 'error': 'view: cannot read: ' + str(e)}
    b64 = base64.b64encode(data).decode('ascii')
    data_url = 'data:' + mime + ';base64,' + b64
    return {'ok': True, 'executed': True, 'view': {
        'path': p, 'size': size, 'mime': mime, 'data_url': data_url,
    }}

def execute(payload):
    command = payload.get('command') or ''
    if not isinstance(command, str):
        return {'ok': False, 'executed': False, 'error': 'command must be a string'}
    command = command.strip()
    # Нормализуем Unicode-пробелы (NBSP из code-блоков чатов) ДО всех проверок:
    # иначе whitelist и danger-patterns не срабатывают, а python падает с SyntaxError.
    command = normalize_whitespace(command)
    # view: спец-команда просмотра изображения (до whitelist)
    if command.lower().startswith("view "):
        return _handle_view(command[5:])
    # whitelist: блокируем неразрешённые команды (если включён)
    ok_wl, wl_reason = _check_whitelist(command)
    if not ok_wl:
        return {'ok': False, 'executed': False, 'blocked': True,
                'error': f'whitelist: {wl_reason}', 'command': command}
    runner = str(payload.get('runner') or 'shell').strip().lower()
    timeout = payload.get('timeout') or DEFAULT_TIMEOUT
    cwd_raw = str(payload.get('cwd') or '').strip()
    cwd = os.path.expanduser(cwd_raw) if cwd_raw else None
    try:
        timeout = max(2, min(int(timeout), 600))
    except (ValueError, TypeError):
        timeout = DEFAULT_TIMEOUT

    if not command:
        return {'ok': False, 'executed': False, 'error': 'empty command'}
    if cwd and not os.path.isdir(cwd):
        return {'ok': False, 'executed': False, 'error': f'cwd not found: {cwd}'}
    if runner not in ('shell', 'python', 'node', 'powershell'):
        return {'ok': False, 'executed': False, 'error': f'unknown runner: {runner}'}
    t0 = time.monotonic()  # замер длительности выполнения

    _log(f'\n[run] runner={runner} timeout={timeout}s cwd={cwd or os.getcwd()}')
    _log(f'--- command ---\n{command[:2000]}')

    try:
        if runner == 'shell':
            p = run_shell(command, timeout, cwd)
        elif runner == 'python':
            # PYTHONUTF8: кириллица/эмодзи в выводе не едут в ???? независимо от кодовой страницы
            py_env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
            p = run_with_tempfile(command, timeout, cwd, '.py', [sys.executable], env=py_env)
        elif runner == 'node':
            p = run_with_tempfile(command, timeout, cwd, '.js', ['node'])
        elif runner == 'powershell':
            # Многострочные скрипты через -Command схлопываются и ломаются на парсинге,
            # поэтому пишем во временный .ps1 и запускаем через -File.
            # BOM (utf-8-sig): иначе PowerShell 5.1 читает UTF-8-кириллицу как мусор.
            ps_code = ("$ProgressPreference='SilentlyContinue'; "
                       "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); "
                       "$OutputEncoding=[System.Text.UTF8Encoding]::new();\n" + command)
            with tempfile.NamedTemporaryFile('w', suffix='.ps1', delete=False, encoding='utf-8-sig') as f:
                f.write(ps_code)
                ps_path = f.name
            try:
                p = subprocess.run(['powershell', '-NoProfile', '-NonInteractive',
                                    '-ExecutionPolicy', 'Bypass', '-File', ps_path],
                                   capture_output=True, timeout=timeout, cwd=cwd or None)
            except FileNotFoundError:
                # Linux/macOS: PowerShell Core ставится как `pwsh`
                p = subprocess.run(['pwsh', '-NoProfile', '-NonInteractive',
                                    '-ExecutionPolicy', 'Bypass', '-File', ps_path],
                                   capture_output=True, timeout=timeout, cwd=cwd or None)
            finally:
                try:
                    os.unlink(ps_path)
                except OSError:
                    pass
    except subprocess.TimeoutExpired as e:
        out = smart_decode(e.stdout)
        err = smart_decode(e.stderr)
        tout_err = (err + '\n' if err else '') + f'[TIMEOUT {timeout}s]'
        clipped_out, _ = _clip(out)
        clipped_err, _ = _clip(tout_err)
        return {'ok': True, 'runner': runner, 'command': command, 'exit_code': 124,
                'executed': True, 'cwd': cwd or os.getcwd(),
                'stdout': clipped_out, 'stderr': clipped_err,
                'truncated': True,
                'stdout_bytes': len(e.stdout or b''), 'stderr_bytes': len(e.stderr or b''),
                'limit_bytes': MAX_OUTPUT, 'duration_ms': int((time.monotonic() - t0) * 1000), 'timed_out': True}
    except FileNotFoundError as e:
        return {'ok': False, 'executed': False, 'error': f'interpreter not found: {e}'}
    except OSError as e:
        return {'ok': False, 'executed': False, 'error': f'execution failed: {e}'}

    raw_out, raw_err = p.stdout or b'', p.stderr or b''
    stdout, stderr = smart_decode(raw_out), smart_decode(raw_err)
    eff_cwd = cwd or os.getcwd()
    clipped_out, t1 = _clip(stdout)
    clipped_err, t2 = _clip(stderr)
    dur_ms = int((time.monotonic() - t0) * 1000)
    _log(f'[done] exit={p.returncode} dur={dur_ms}ms stdout={len(raw_out)}B stderr={len(raw_err)}B')
    return {'ok': True, 'runner': runner, 'command': command, 'exit_code': p.returncode,
            'executed': True, 'cwd': eff_cwd,
            'stdout': clipped_out, 'stderr': clipped_err, 'truncated': (t1 or t2),
            'stdout_bytes': len(raw_out), 'stderr_bytes': len(raw_err), 'limit_bytes': MAX_OUTPUT,
            'duration_ms': dur_ms, 'timed_out': False}

class Handler(BaseHTTPRequestHandler):
    server_version = 'AIExecuteRunner/' + VERSION

    def _allowed(self):
        # Защита от DNS-rebinding и чужих сайтов:
        # Host обязан быть локальным, Origin — пустым (curl/навигация),
        # chrome-extension:// (наше расширение) или локальным.
        host = (self.headers.get('Host') or '').split(':')[0].strip().lower()
        if host not in ('127.0.0.1', 'localhost', '[::1]', '::1'):
            return False
        origin = (self.headers.get('Origin') or '').strip()
        if not origin:
            return True
        try:
            o = urlparse(origin)
            if o.scheme in ('chrome-extension', 'moz-extension'):
                return True
            if o.hostname in ('127.0.0.1', 'localhost'):
                return True
        except Exception:
            return False
        return False

    def _check_token(self):
        """True если токен валиден (или не требуется). False - отклонить."""
        if not AUTH_TOKEN:
            return True
        got = (self.headers.get('X-Auth-Token') or '').strip()
        return hmac.compare_digest(got, AUTH_TOKEN)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token')

    def do_OPTIONS(self):
        if not self._allowed():
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._allowed():
            return self._json({'ok': False, 'error': 'forbidden: bad Host/Origin'}, 403)
        req_path = urlparse(self.path).path
        if req_path.rstrip('/') in ('/ping', ''):
            self._json({'status': 'ok', 'version': VERSION, 'platform': platform.system(),
                        'cwd': os.getcwd(), 'python': sys.version.split()[0],
                        'auth_required': bool(AUTH_TOKEN),
                        'whitelist_on': WHITELIST is not None,
                        'whitelist_size': len(WHITELIST) if WHITELIST else 0,
                        'auth_ok': (None if not AUTH_TOKEN else hmac.compare_digest(
                            (self.headers.get('X-Auth-Token') or '').strip(), AUTH_TOKEN))})
        else:
            self._json({'ok': False, 'error': 'unknown endpoint'}, 404)

    def do_POST(self):
        if not self._allowed():
            return self._json({'ok': False, 'error': 'forbidden: bad Host/Origin'}, 403)
        if urlparse(self.path).path.rstrip('/') != '/run':
            return self._json({'ok': False, 'error': 'unknown endpoint'}, 404)
        if not self._check_token():
            return self._json({'ok': False, 'error': 'invalid or missing token (X-Auth-Token)'}, 401)
        ok_rate, wait_s = _check_rate()
        if not ok_rate:
            return self._json({'ok': False, 'error': f'rate limit exceeded ({RATE_LIMIT}/min), retry in {wait_s:.1f}s'}, 429)
        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            length = 0
        if length < 0:
            length = 0
        if length > 10_000_000:
            return self._json({'ok': False, 'error': 'body too large (max 10MB)'}, 413)
        try:
            self.request.settimeout(15)
            raw = self.rfile.read(length) if length else b'{}'
        except (TimeoutError, OSError):
            return self._json({'ok': False, 'error': 'read timeout'}, 408)
        finally:
            try:
                self.request.settimeout(None)
            except OSError:
                pass
        try:
            payload = json.loads(raw.decode('utf-8') or '{}')
        except (ValueError, UnicodeDecodeError, RecursionError):
            return self._json({'ok': False, 'error': 'invalid JSON'}, 400)
        if not isinstance(payload, dict):
            return self._json({'ok': False, 'error': 'JSON body must be an object'}, 400)
        result = execute(payload)
        self._json(result, 200 if result.get('ok') else 400)

    def log_message(self, fmt, *args):
        # Расширение дёргает /ping каждые ~30 сек для зелёного бейджа —
        # по умолчанию такие проверки НЕ логируем, чтобы не спамить консоль.
        # Полный лог включается флагом:  python server.py --verbose
        if not VERBOSE and args and isinstance(args[0], str) and args[0].startswith('GET /ping'):
            return
        _log('[http] ' + fmt % args)

class QuietServer(ThreadingHTTPServer):
    """Многопоточный сервер: /ping отвечает мгновенно даже во время долгой команды.
    daemon_threads=True — Ctrl+C завершает процесс сразу, не waiting зависшие команды."""
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Клиент сам разорвал соединение (abort/timeout в браузере) — это не ошибка
        # сервера, молча игнорируем, чтобы не спамить консоль трейсбеками WinError 10053.
        ex = sys.exc_info()[1]
        if isinstance(ex, (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main():
    global VERBOSE, MAX_OUTPUT
    # Windows-консоли (cp866/cp1251) падают на эмодзи/тире в print() —
    # заменяем непечатаемое на ?, вместо UnicodeEncodeError и краха сервера.
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--verbose', action='store_true',
                    help='логировать все запросы, включая проверки /ping')
    ap.add_argument('--max-output', type=int, default=1000000,
                    help='лимит stdout/stderr в байтах (0 = без лимита)')
    ap.add_argument('--cwd', default=None,
                    help='рабочий каталог сервера (по умолчанию — папка запуска)')
    ap.add_argument('--token', default=None,
                    help='свой токен (по умолчанию генерируется случайный)')
    ap.add_argument('--no-token', action='store_true',
                    help='отключить токен-аутентификацию (не рекомендуется)')
    ap.add_argument('--log', default=None,
                    help='файл для логов (по умолчанию — только консоль)')
    ap.add_argument('--rate-limit', type=int, default=0,
                    help='макс. команд в минуту (0 = без лимита)')
    ap.add_argument('--whitelist', default=None, metavar='FILE',
                    help='файл со списком разрешённых команд (включает whitelist-режим)')
    args = ap.parse_args()
    VERBOSE = args.verbose
    MAX_OUTPUT = args.max_output if args.max_output >= 0 else 1_000_000
    global AUTH_TOKEN
    if args.no_token:
        AUTH_TOKEN = None
    elif args.token:
        AUTH_TOKEN = args.token.strip()
    else:
        AUTH_TOKEN = secrets.token_urlsafe(24)
    global LOG_FILE, RATE_LIMIT
    LOG_FILE = args.log.strip() if args.log else None
    RATE_LIMIT = max(0, args.rate_limit)
    global WHITELIST
    if args.whitelist:
        try:
            WHITELIST = _load_whitelist(os.path.expanduser(args.whitelist.strip("'\"")))
        except (OSError, RuntimeError) as e:
            print(f'ошибка: не могу прочитать whitelist: {e}')
            sys.exit(1)
    # Стартовый cwd: запуск из системной папки (System32 через ярлык/автозапуск)
    # ломает все относительные пути — в этом случае уходим в домашнюю папку.
    if args.cwd:
        cwd_arg = os.path.expanduser(args.cwd.strip('"\''))
        if not os.path.isdir(cwd_arg):
            print(f'ошибка: папка --cwd не найдена: {args.cwd}')
            sys.exit(1)
        os.chdir(cwd_arg)
    elif os.name == 'nt' and os.path.basename(os.getcwd()).lower() in ('system32', 'syswow64', 'windows'):
        home = os.path.expanduser('~')
        print(f'  [!] стартовый каталог {os.getcwd()} — системный, перехожу в {home}')
        os.chdir(home)
    try:
        srv = QuietServer(('127.0.0.1', args.port), Handler)
    except OSError as e:
        print(f'ошибка: не могу занять порт {args.port}: {e}')
        sys.exit(1)
    _log('=' * 60)
    _log(f'  AI Execute Runner v{VERSION} — локальный сервер запущен')
    _log(f'  http://127.0.0.1:{args.port}  (только этот ПК, platform={platform.system()})')
    _log('  Откройте ChatGPT / Claude / Arena, ИИ пишет ```execute — подтверждайте запуск.')
    _log(f'  Лимит вывода: {MAX_OUTPUT} байт (0 = без лимита)')
    _log(f'  Рабочий каталог: {os.getcwd()}')
    if AUTH_TOKEN:
        _log(f'  Токен доступа: {AUTH_TOKEN}')
        _log('  Скопируйте его в настройки расширения (поле Токен)')
    else:
        _log('  [!] Токен-аутентификация отключена (--no-token)')
    if WHITELIST is not None:
        _log(f'  Whitelist: ВКЛЮЧЁН ({len(WHITELIST)} префиксов из {args.whitelist})')
    else:
        _log('  Whitelist: выключен (--whitelist FILE чтобы включить)')
    _log('  Остановка: Ctrl+C')
    _log('=' * 60)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\nbye!')

if __name__ == '__main__':
    main()
