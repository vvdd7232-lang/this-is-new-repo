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
# mcp_client лежит рядом, но server.py бывает запущен из другой папки (ярлык,
# автозапуск) — поэтому добавляем свою папку в sys.path перед импортом.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mcp_client as _mcp  # noqa: E402
from urllib.parse import urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '2.10.0'
MAX_OUTPUT = 1_000_000  # лимит stdout/stderr (меняется флагом --max-output, 0 = без лимита)
DEFAULT_TIMEOUT = 30
AUTH_TOKEN = None  # если задан - требуется заголовок X-Auth-Token для POST /run
LOG_FILE = None  # путь к файлу логов (None = только консоль)
RATE_LIMIT = 0  # N команд в минуту (0 = без лимита)
WHITELIST = None  # None = выключен; frozenset префиксов (lowercase) = включён

# --- MCP (экспериментально) --------------------------------------------------

def _mcp_clip_limit():
    """Лимит на один текстовый блок в ответе MCP, в байтах (0 = без лимита).

    Отдельная функция, а не константа, чтобы лимит зависел от того же флага
    --max-output, что и shell-вывод: два независимых рычага для одного понятия
    «сколько максимум» быстро расходятся."""
    return MAX_OUTPUT


def _desktop_dir():
    """Папка «Рабочий стол»: у разных людей она называется по-разному."""
    home = os.path.expanduser('~')
    candidates = [
        os.path.join(home, 'Desktop'),
        os.path.join(home, 'OneDrive', 'Desktop'),
        os.path.join(home, 'Рабочий стол'),
        os.path.join(home, 'OneDrive', 'Рабочий стол'),
    ]
    for path in candidates:
        if os.path.isdir(path):
            return path
    return home


def _format_arg_schema(schema):
    """Человекочитаемый разбор inputSchema: «size (number, обязательно)»."""
    if not isinstance(schema, dict):
        return []
    props = schema.get('properties')
    if not isinstance(props, dict) or not props:
        return []
    required = schema.get('required') or []
    lines = []
    for name in sorted(props):
        spec = props[name] if isinstance(props[name], dict) else {}
        kind = spec.get('type') or 'any'
        if spec.get('enum'):
            kind = '%s (%s)' % (kind, ' | '.join(str(x) for x in spec['enum']))
        flag = 'обязательный' if name in required else 'необязательный'
        desc = str(spec.get('description') or '').strip()
        lines.append('  - %s (%s, %s)%s' % (
            name, kind, flag, (': ' + desc[:120]) if desc else ''))
    return lines


def _mcp_tools_report():
    """Собирает отчёт по инструментам MCP — в таком виде его можно скормить ИИ.

    Зачем: модель не выдумывает имена инструментов, если у неё есть список.
    Поэтому в отчёте точное имя, описание, схема аргументов и готовый
    пример блока execute-mcp.
    """
    servers_out = []
    total = 0
    for client in sorted(MCP_REGISTRY.clients.values(), key=lambda c: c.name):
        entry = {'name': client.name, 'command': client.command,
                 'args': client.args, 'enabled': client.enabled,
                 'error': '', 'tools': []}
        if not client.enabled:
            servers_out.append(entry)
            continue
        try:
            entry['tools'] = client.list_tools()
            MCP_REGISTRY.errors[client.name] = ''
        except _mcp.McpError as e:
            entry['error'] = str(e)
        total += len(entry['tools'])
        servers_out.append(entry)

    lines = ['# MCP-инструменты (AI Execute Runner)', '']
    lines.append('Список инструментов внешних MCP-серверов. Используй ТОЛЬКО эти имена:')
    lines.append('несуществующий сервер или инструмент вернёт ошибку.')
    lines.append('')
    for entry in servers_out:
        if not entry['enabled']:
            lines.append('## %s — выключен (enabled: false)' % entry['name'])
            continue
        if entry['error']:
            lines.append('## %s — НЕ ЗАПУСКАЕТСЯ: %s' % (entry['name'], entry['error']))
            lines.append('')
            continue
        lines.append('## %s  (%s)' % (entry['name'], ' '.join([entry['command']] + entry['args'])))
        lines.append('Инструментов: %d' % len(entry['tools']))
        lines.append('')
        for tool in entry['tools'][:_mcp.MAX_TOOLS_PER_SERVER]:
            if not isinstance(tool, dict) or not tool.get('name'):
                continue
            lines.append('### %s' % tool['name'])
            desc = str(tool.get('description') or '').strip()
            if desc:
                lines.append(desc[:400])
            args = _format_arg_schema(tool.get('inputSchema'))
            if args:
                lines.append('Аргументы:')
                lines.extend(args)
            else:
                lines.append('Аргументы: нет')
            sample = {'server': entry['name'], 'tool': tool['name'], 'arguments': {}}
            schema = tool.get('inputSchema')
            if isinstance(schema, dict) and isinstance(schema.get('properties'), dict):
                for pname, pspec in schema['properties'].items():
                    if not isinstance(pspec, dict):
                        continue
                    if pspec.get('type') == 'number':
                        sample['arguments'][pname] = 1
                    elif pspec.get('type') == 'boolean':
                        sample['arguments'][pname] = False
                    elif pspec.get('enum'):
                        sample['arguments'][pname] = pspec['enum'][0]
                    else:
                        sample['arguments'][pname] = 'значение'
            lines.append('Пример блока:')
            lines.append('```execute-mcp')
            lines.append(json.dumps(sample, ensure_ascii=False))
            lines.append('```')
            lines.append('')
    return servers_out, total, '\n'.join(lines)


def _stdin_is_tty():
    """True только для настоящего интерактивного терминала.

    Зачем: сервер часто стартует из ярлыка, автозагрузки или CI, где stdin —
    перенаправленный поток. Там input() либо блокирует навсегда, либо падает,
    поэтому в таких случаях вопрос про MCP задавать нельзя."""
    try:
        return bool(sys.stdin) and bool(sys.stdin.isatty())
    except Exception:
        return False


def _say(text):
    """print, который не падает на однобайтовой консоли (cp866/cp1251).

    main() перенастраивает stdout, но _prompt_mcp вызывается и тестами, и из
    других мест: падать из-за «красивых» букв пользователю нельзя."""
    try:
        print(text)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, 'encoding', None) or 'ascii'
        print(text.encode(enc, 'replace').decode(enc, 'replace'))


def _prompt_mcp(cfg):
    """Спрашивает, включать ли MCP. Возвращает True/False.

    Конфиг намеренно НЕ переписывается: выбор влияет только на текущий запуск.
    Иначе сервер, запущенный из ярлыка с ответом по умолчанию, молча включил бы
    экспериментальные возможности в файле пользователя."""
    if not _stdin_is_tty():
        return False
    _say('')
    _say('  MCP [экспериментально] — внешние MCP-серверы (Godot, Blender и др.)')
    _say(f'  конфиг: {cfg}')
    try:
        servers = _mcp.load_config(cfg)
    except _mcp.McpError as e:
        _say(f'  [!] {e}')
        return False
    if not servers:
        _say('  В конфиге нет ни одного MCP-сервера — включать нечего.')
        _say('  Описание серверов: server/mcp_servers.json')
        return False
    active = sorted(c.name for c in servers if c.enabled)
    if active:
        _say('  Активные серверы: ' + ', '.join(active))
    else:
        _say('  Активных серверов нет: в конфиге у всех enabled: false.')
        _say('  Включить нужные можно в server/mcp_servers.json')
    _say('  Подробности: настройки расширения → раздел «Экспериментальное»')
    try:
        ans = _ask('  Включить MCP? [y/N] ').strip().lower()
    except (EOFError, KeyboardInterrupt):
        _say('')
        return False
    except Exception:
        # Обрыв сокета, закрытый stdin и прочее: сервер обязан стартовать,
        # а не падать из-за вопроса, который не влез в экран.
        return False
    return ans in ('y', 'yes', 'д', 'да', '1')


def _ask(prompt):
    """input(), который тоже не падает на однобайтовой консоли."""
    try:
        return input(prompt)
    except UnicodeEncodeError:
        enc = getattr(sys.stdout, 'encoding', None) or 'ascii'
        return input(prompt.encode(enc, 'replace').decode(enc, 'replace'))
# Браузер не умеет запускать процессы, поэтому внешние MCP-серверы (Godot,
# Blender и др.) поднимает сам server.py и говорит с ними по stdio.
# Пока выключено: MCP_REGISTRY is None → эндпоинты отвечают «выключено».
MCP_REGISTRY = None
MCP_CONFIG = None
# Shell-метасимволы. Перевод строки здесь обязателен: многострочный текст уходит
# в .cmd-файл и выполняется построчно, поэтому `cd .\nrm -rf /` раньше проходил
# проверку как «команда с разрешённым префиксом cd».
_WHITELIST_META = re.compile(r'[;&|<>`]|\$\(|[\r\n]')

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
        return False, ('shell metacharacters (; & | < > ` $( and line breaks) '
                       'not allowed in whitelist mode')
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
    # whitelist: блокируем неразрешённые команды (если включён) ДО спец-команд,
    # иначе `view` читал бы файлы с диска в обход политики whitelist.
    ok_wl, wl_reason = _check_whitelist(command)
    if not ok_wl:
        return {'ok': False, 'executed': False, 'blocked': True,
                'error': f'whitelist: {wl_reason}', 'command': command}
    # view: спец-команда просмотра изображения
    if command.lower().startswith("view "):
        return _handle_view(command[5:])
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
        self._cors_origin = 'null'  # per-request; атрибут класса здесь не годится
        host = (self.headers.get('Host') or '').split(':')[0].strip().lower()
        if host not in ('127.0.0.1', 'localhost', '[::1]', '::1'):
            return False
        origin = (self.headers.get('Origin') or '').strip()
        if not origin:
            return True
        try:
            o = urlparse(origin)
            if o.scheme in ('chrome-extension', 'moz-extension'):
                self._cors_origin = origin
                return True
            if o.hostname in ('127.0.0.1', 'localhost'):
                self._cors_origin = origin
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
        # Никакого `*`: Origin-проверка выше и так отсекает чужие сайты, но
        # wildcard превратился бы в дыру, если её когда-нибудь ослабят.
        self.send_header('Access-Control-Allow-Origin', getattr(self, '_cors_origin', 'null'))
        self.send_header('Vary', 'Origin')
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
        req_path = urlparse(self.path).path.rstrip('/') or '/'
        if req_path == '/mcp/servers':
            if not self._check_token():
                return self._json({'ok': False, 'error': 'invalid or missing token (X-Auth-Token)'}, 401)
            if MCP_REGISTRY is None:
                return self._json({'ok': True, 'enabled': False, 'servers': [], 'tools': 0,
                                   'config': MCP_CONFIG or '', 'hint': 'запустите сервер с --mcp'})
            return self._json({'ok': True, 'enabled': True, 'servers': MCP_REGISTRY.describe(),
                               'tools': 0, 'config': MCP_REGISTRY.config_path,
                               'config_error': MCP_REGISTRY.load_error})
        if req_path in ('/ping', '/'):
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
        req_path = urlparse(self.path).path.rstrip('/') or '/'
        if req_path in ('/mcp/tools', '/mcp/call', '/mcp/reload', '/mcp/report'):
            return self._mcp_post(req_path)
        if req_path != '/run':
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

    # ---------- MCP (экспериментально) ----------
    def _mcp_guard(self):
        """Общие ограничения для /mcp/*. Возвращает (ошибка_json, код) либо None.

        Проверки живут здесь, а не в расширении: расширение можно закрыть
        страницей чата или подменить скрипт, а сервер — это точка доверия.
        """
        if not self._check_token():
            return {'ok': False, 'error': 'invalid or missing token (X-Auth-Token)'}, 401
        if MCP_REGISTRY is None:
            return {'ok': False, 'error': 'MCP выключен: запустите сервер с флагом --mcp'}, 400
        # Whitelist проверяет shell-команды, а tools/call — нет. Молча пропускать
        # его в whitelist-режиме означало бы, что защита дырявая: модель пишет
        # файлы и исполняет код в обход. Лучше честный отказ.
        if WHITELIST is not None:
            return {'ok': False, 'error': 'whitelist-режим: вызовы MCP заблокированы, '
                    'так как whitelist проверяет только shell-команды. '
                    'Запустите сервер без --whitelist, чтобы использовать MCP.'}, 403
        if RATE_LIMIT > 0:
            ok_rate, wait_s = _check_rate()
            if not ok_rate:
                return {'ok': False, 'error': f'rate limit exceeded ({RATE_LIMIT}/min), '
                        f'retry in {wait_s:.1f}s'}, 429
        return None

    def _mcp_body(self):
        """Читает и валидирует JSON-тело. Возвращает (dict, None) или (None, ответ)."""
        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            length = 0
        if length < 0:
            length = 0
        if length > 1_000_000:
            return None, self._json({'ok': False, 'error': 'body too large (max 1MB)'}, 413)
        try:
            raw = self.rfile.read(length) if length else b'{}'
        except (TimeoutError, OSError):
            return None, self._json({'ok': False, 'error': 'read timeout'}, 408)
        try:
            payload = json.loads(raw.decode('utf-8') or '{}')
        except (ValueError, UnicodeDecodeError):
            return None, self._json({'ok': False, 'error': 'invalid JSON'}, 400)
        if not isinstance(payload, dict):
            return None, self._json({'ok': False, 'error': 'JSON body must be an object'}, 400)
        return payload, None

    def _mcp_post(self, req_path):
        blocked = self._mcp_guard()
        if blocked is not None:
            return self._json(blocked[0], blocked[1])

        payload, err = self._mcp_body()
        if err is not None:
            return err

        if req_path == '/mcp/reload':
            MCP_REGISTRY.reload()
            return self._json({'ok': True, 'servers': MCP_REGISTRY.describe(),
                               'config': MCP_REGISTRY.config_path,
                               'config_error': MCP_REGISTRY.load_error})

        if req_path == '/mcp/tools':
            try:
                tools = MCP_REGISTRY.collect_tools()
            except _mcp.McpError as e:
                return self._json({'ok': False, 'error': str(e)}, 400)
            return self._json({'ok': True, 'tools': tools, 'count': len(tools),
                               'servers': MCP_REGISTRY.describe()})

        if req_path == '/mcp/report':
            # Отчёт для ИИ: точный список инструментов со схемами и примерами.
            # Почему здесь, а не в расширении: сервер уже знает протокол и
            # единственный, кто умеет писать на диск.
            servers_out, total, text = _mcp_tools_report()
            saved_to = ''
            if payload.get('save'):
                target = os.path.join(_desktop_dir(), 'mcp-tools.md')
                try:
                    with open(target, 'w', encoding='utf-8') as fh:
                        fh.write(text)
                        fh.write('\n')
                    saved_to = target
                except OSError as e:
                    return self._json({'ok': False, 'error': 'не удалось сохранить: %s' % e}, 400)
            return self._json({'ok': True, 'count': total, 'text': text,
                               'saved_to': saved_to, 'servers': servers_out})

        # /mcp/call
        server = str(payload.get('server') or '').strip()
        tool = str(payload.get('tool') or payload.get('name') or '').strip()
        arguments = payload.get('arguments')
        if not server or not tool:
            return self._json({'ok': False, 'error': 'нужны поля server и tool'}, 400)
        if arguments is None:
            arguments = {}
        if not isinstance(arguments, dict):
            return self._json({'ok': False, 'error': 'arguments должен быть объектом'}, 400)
        # __proto__/constructor/prototype в аргументах — мусор, которому не
        # место в протоколе: часть MCP-серверов (JS-реализации) спотыкается о
        # такой ключ, а для Python он просто лишний.
        for bad_key in ('__proto__', 'constructor', 'prototype'):
            if bad_key in arguments:
                return self._json({'ok': False,
                                   'error': 'arguments: недопустимый ключ ' + bad_key}, 400)
        timeout = payload.get('timeout')
        try:
            timeout = float(timeout) if timeout else None
        except (TypeError, ValueError):
            timeout = None
        # Потолок таймаута: иначе payload с timeout=999999 держит поток сервера
        # и процесс MCP-сервера часами после того, как пользователь ушёл.
        if timeout is not None:
            timeout = max(1.0, min(timeout, 600.0))
        try:
            result = MCP_REGISTRY.call(server, tool, arguments, timeout)
        except _mcp.McpError as e:
            return self._json({'ok': False, 'error': str(e), 'server': server, 'tool': tool}, 400)
        # Обрезка ответа MCP. Раньше лимит применялся только к shell-выводу, и
        # инструмент, вернувший десятки мегабайт (лог, base64-текстура), уходил
        # в JSON целиком — память, сеть и журнал страдали, а обрезка в
        # расширении случалась уже после этого.
        limit = _mcp_clip_limit()
        truncated = False
        if limit > 0:
            content = result.get('content') if isinstance(result, dict) else None
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and isinstance(part.get('text'), str):
                        if len(part['text']) > limit:
                            part['text'] = part['text'][:limit] + (
                                '\n… обрезано сервером (лимит %d байт)' % limit)
                            truncated = True
                            break
        return self._json({'ok': True, 'server': server, 'tool': tool,
                           'result': result, 'truncated': truncated})

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


def _setup_payload(port, token):
    """Готовит base64url-полезную нагрузку для ссылки настройки в один клик.

    Расширение разбирает её в options.js (#ax-setup=…) и само подставляет адрес
    сервера и токен — это убирает самую частую ошибку первого запуска
    («бейдж offline» и 401 из-за незаполненного токена).
    """
    payload = json.dumps({'url': f'http://127.0.0.1:{port}', 'token': token},
                         ensure_ascii=False).encode('utf-8')
    return base64.urlsafe_b64encode(payload).decode('ascii').rstrip('=')


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
    ap.add_argument('--mcp', action='store_true',
                    help='[экспериментально] включить MCP без вопроса')
    ap.add_argument('--no-mcp', action='store_true',
                    help='[экспериментально] не задавать вопрос про MCP и не включать его')
    ap.add_argument('--yes', action='store_true',
                    help='отвечать «да» на интерактивные вопросы (для скриптов и ярлыков)')
    ap.add_argument('--mcp-config', default=None, metavar='FILE',
                    help='конфиг MCP-серверов (по умолчанию server/mcp_servers.json)')
    args = ap.parse_args()
    VERBOSE = args.verbose
    MAX_OUTPUT = args.max_output if args.max_output >= 0 else 1_000_000
    global AUTH_TOKEN
    if args.no_token:
        AUTH_TOKEN = None
    elif args.token and args.token.strip():
        AUTH_TOKEN = args.token.strip()
    else:
        # Пустая строка в --token не должна ТИХО отключать аутентификацию: это
        # выглядело бы как «токен задан», а сервер оставался бы открытым.
        # Явное отключение — только флаг --no-token.
        if args.token is not None:
            print('  [!] --token пустой — отключение только через --no-token; '
                  'генерирую случайный токен')
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
    # --- MCP: приоритет флагов, иначе интерактивный выбор (экспериментально) ---
    global MCP_REGISTRY, MCP_CONFIG
    # Личный конфиг важнее шаблона: пользователь правит mcp_servers.local.json
    # (в .gitignore), а mcp_servers.json остаётся выключенным шаблоном, который
    # едет в server.zip. Так настройки не затираются при обновлении и не уезжают
    # в репозиторий — тем же приёмом, что и с whitelist.
    _mcp_dir = os.path.dirname(os.path.abspath(__file__))
    _mcp_local = os.path.join(_mcp_dir, 'mcp_servers.local.json')
    if args.mcp_config:
        _mcp_cfg = os.path.expanduser(args.mcp_config)
    elif os.path.exists(_mcp_local):
        _mcp_cfg = _mcp_local
    else:
        _mcp_cfg = os.path.join(_mcp_dir, 'mcp_servers.json')
    if args.mcp:
        want_mcp = True          # попросили явно
    elif args.no_mcp:
        want_mcp = False         # попросили не спрашивать
    elif args.yes:
        want_mcp = True          # неинтерактивный запуск: согласие подразумевается флагом
    else:
        want_mcp = _prompt_mcp(_mcp_cfg)
    if want_mcp:
        MCP_CONFIG = _mcp_cfg
        MCP_REGISTRY = _mcp.Registry(_mcp_cfg)
        if MCP_REGISTRY.load_error:
            print(f'  [!] MCP: {MCP_REGISTRY.load_error}')
        enabled = [c for c in MCP_REGISTRY.clients.values() if c.enabled]
        if enabled:
            _log(f'  MCP [экспериментально]: {len(enabled)} сервер(ов) — '
                 + ', '.join(sorted(c.name for c in enabled)))
            _log(f'  конфиг MCP: {_mcp_cfg}')
        else:
            _log(f'  MCP [экспериментально]: включён, но активных серверов нет ({_mcp_cfg})')
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
        # Токен НЕ пишем в файл лога: он секрет, а --log может уехать в облако/тикеты.
        # В консоль печатаем всегда (пользователю надо его увидеть и скопировать).
        print(f'  Токен доступа: {AUTH_TOKEN}')
        print('  Скопируйте его в настройки расширения (поле Токен)')
        _log('  ---- настройка в один клик ----')
        _log('  Откройте страницу настроек расширения и вставьте ссылку ниже в адресную')
        _log('  строку браузера — адрес и токен подставятся сами:')
        for scheme in ('chrome-extension', 'moz-extension'):
            print(f'  {scheme}://<ID расширения>/options.html#ax-setup={_setup_payload(args.port, AUTH_TOKEN)}')
        _log('  <ID расширения>: chrome://extensions (Chrome) или about:debugging (Firefox)')
        if LOG_FILE:
            _log('  Токен доступа: <скрыт> (см. консоль; в файл лога не пишется)')
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
    finally:
        # MCP-серверы — это subprocess'ы; без явного terminate они остались бы
        # висеть после Ctrl+C и держать Blender/Godot заблокированными.
        if MCP_REGISTRY is not None:
            try:
                MCP_REGISTRY.shutdown()
            except Exception:
                pass

if __name__ == '__main__':
    main()
