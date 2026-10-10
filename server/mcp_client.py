"""MCP-клиент для AI Execute Runner (экспериментальная функция).

Зачем он здесь
--------------
MCP-серверы (Godot MCP, Blender MCP и прочие) почти всегда работают через
stdio: это отдельный процесс, который говорит JSON-RPC 2.0 через stdin/stdout.
Браузер запускать процессы не умеет в принципе, поэтому посредником обязан быть
server.py — он и так локальный, и так уже выполняет команды от имени ИИ.

Этот модуль делает три вещи:
  1. читает список MCP-серверов из конфига;
  2. поднимает каждый как subprocess и говорит с ним по MCP (initialize → tools/list);
  3. даёт вызвать инструмент (tools/call) и отдаёт результат.

Ограничения (осознанные, в UI помечены как «экспериментально»):
  * поддерживаются два транспорта:
      - stdio — локальный процесс (filesystem, playwright, git, brave-search);
      - http — Streamable HTTP для удалённых серверов (context7, zapier,
        notion, atlassian). Ничего ставить не нужно, но нужен доступ в сеть.
  * OAuth-авторизация (Zapier, Notion, Atlassian) НЕ реализована: работают
    только серверы, которым хватает статического токена в заголовке.
  * сервер держится живым между вызовами; если упал — поднимется заново.

Список конкретных серверов с командами — в docs/mcp-servers.md. В
server/mcp_servers.json они намеренно НЕ прописаны: включение должно быть
осознанным, иначе расширение при первом же запуске начнёт поднимать
процессы и ходить в интернет без спроса.
"""

import json
import os
import queue
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request

PROTOCOL_VERSION = '2024-11-05'
CLIENT_INFO = {'name': 'ai-execute-runner', 'version': '2.11.3'}
DEFAULT_TIMEOUT = 30.0
MAX_TOOLS_PER_SERVER = 200
# Потолок одной строки от MCP-сервера и глубина очереди сообщений. Без них
# «сервер, который льёт в stdout» съедает память процесса: очередь растёт
# бесконечно, пока пользователь смотрит на панель.
MAX_LINE_BYTES = 8 * 1024 * 1024
QUEUE_MAX_MESSAGES = 256


def _log(msg):
    # server.py переопределяет _log; здесь нужен безопасный вариант, чтобы
    # модуль можно было импортировать и тестировать отдельно.
    try:
        from server import _log as srv_log  # type: ignore
        srv_log(msg)
    except Exception:
        print('[mcp] ' + msg)


class McpError(Exception):
    """Ошибка обращения к MCP-серверу. Текст всегда показывается пользователю."""


class McpServerClient:
    """Один MCP-сервер: subprocess + JSON-RPC 2.0 поверх stdio."""

    def __init__(self, name, command, args=None, env=None, cwd=None,
                 timeout=DEFAULT_TIMEOUT, enabled=True):
        self.name = name
        self.command = command
        self.args = list(args or [])
        self.env = dict(env or {})
        self.cwd = cwd
        self.timeout = timeout
        self.enabled = enabled
        # Единый интерфейс с McpHttpClient: реестру и UI неважно, stdio это
        # или удалённый сервер.
        self.transport = 'stdio'
        self.url = ''
        self.proc = None
        self.next_id = 1
        self.server_info = {}
        self.capabilities = {}
        self.last_error = ''
        self._lock = threading.Lock()          # запросы строго по одному
        self._err_lock = threading.Lock()
        self._stderr_buf = b''
        self._stderr_thread = None
        self._queue = queue.Queue(maxsize=QUEUE_MAX_MESSAGES)      # сообщения от потока-читателя
        self._reader_thread = None
        self._waiting_for = None

    # ---------- жизненный цикл ----------
    def is_running(self):
        return self.proc is not None and self.proc.poll() is None

    def stop(self):
        with self._lock:
            proc, self.proc = self.proc, None
        if proc is None:
            return
        for closer in (lambda: proc.stdin.close(), proc.terminate):
            try:
                closer()
            except Exception:
                pass
        try:
            proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    def start(self):
        """Поднимает процесс. Повторный вызов безопасен."""
        with self._lock:
            if self.is_running():
                return
            if not self.command:
                raise McpError('не указана команда запуска')
            env = dict(os.environ)
            env.update(self.env)
            # Многие MCP-серверы печатают в stderr логи. Если дать им буфер, он
            # переполнится и сервер упадёт на записи — поэтому сразу читаем
            # stderr в фоне и складываем в кольцевой буфер для диагностики.
            env.setdefault('PYTHONIOENCODING', 'utf-8')
            # Разрешаем команду через PATH. Без этого на Windows не запускается
            # практически ничего node-based: там лежит реальный файл npx.CMD,
            # а Popen ищет точное имя 'npx' и падает с FileNotFoundError —
            # то есть «команда не найдена» при установленном nodejs.
            exe = shutil.which(self.command) or self.command
            try:
                self.proc = subprocess.Popen(
                    [exe] + self.args,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=self.cwd or None, env=env, bufsize=0)
            except FileNotFoundError:
                self.proc = None
                raise McpError('команда не найдена: %s' % self.command)
            except OSError as e:
                self.proc = None
                raise McpError('не удалось запустить %s: %s' % (self.command, e))
            self.next_id = 1
            self.server_info = {}
            self.capabilities = {}
            self._stderr_buf = b''
            self._queue = queue.Queue(maxsize=QUEUE_MAX_MESSAGES)
            self._stderr_thread = threading.Thread(
                target=self._drain_stderr, daemon=True)
            self._stderr_thread.start()
            self._reader_thread = threading.Thread(
                target=self._read_stdout, args=(self.proc.stdout, self._queue),
                daemon=True)
            self._reader_thread.start()

    def _read_stdout(self, stream, out_queue):
        """Поток-читатель: без него readline() блокировался бы навсегда и
        таймаут не мог бы сработать (сервер может просто молчать).

        Ограничения на размер и глубину нужны потому, что stdout читает
        СЕРВЕР, которому мы доверяем лишь настолько, насколько доверяют
        пользователю: поток, залививший мегабайты в одну «строку», иначе
        съедал бы память процесса, пока пользователь смотрит на панель.
        """
        try:
            for raw in iter(stream.readline, b''):
                line = raw.strip()
                if not line:
                    continue
                if len(line) > MAX_LINE_BYTES:
                    # Сервер присылает нечто непристойное: рвём протокол.
                    raise McpError('сервер «%s» прислал строку больше %d байт'
                                   % (self.name, MAX_LINE_BYTES))
                try:
                    out_queue.put(json.loads(line.decode('utf-8')), timeout=5)
                except (ValueError, UnicodeDecodeError):
                    continue          # мусор в stdout — не ошибка протокола
                except queue.Full:
                    # Ответ не нужен (например, уведомление, которого мы не
                    # ждём). Молча пропускаем: очередь конечна.
                    continue
        except McpError:
            pass
        except Exception:
            pass
        finally:
            try:
                out_queue.put(None, timeout=5)   # EOF: читатель дочитал
            except queue.Full:
                pass

    # ---------- JSON-RPC ----------
    def _send(self, method, params=None, notification=False):
        if not self.is_running():
            raise McpError('сервер «%s» не запущен' % self.name)
        msg = {'jsonrpc': '2.0', 'method': method}
        if params is not None:
            msg['params'] = params
        rid = None
        if not notification:
            rid = self.next_id
            self.next_id += 1
            msg['id'] = rid
        try:
            self.proc.stdin.write((json.dumps(msg, ensure_ascii=False) + '\n').encode('utf-8'))
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            raise McpError('соединение с «%s» потеряно: %s' % (self.name, e))
        return None if notification else rid

    def _drain_stderr(self):
        """Читает stderr в фоне, чтобы не дать процессу застрять на записи."""
        proc = self.proc
        if proc is None or proc.stderr is None:
            return
        try:
            for chunk in iter(lambda: proc.stderr.read(4096), b''):
                with self._err_lock:
                    self._stderr_buf += chunk
                    if len(self._stderr_buf) > 8192:
                        self._stderr_buf = self._stderr_buf[-4096:]
        except Exception:
            pass

    def _stderr_tail(self):
        """Последние строки stderr упавшего сервера — обычно там причина."""
        try:
            proc = self.proc
            if proc is None or proc.stderr is None:
                return ''
            with self._err_lock:
                text = self._stderr_buf.decode('utf-8', 'replace').strip()
        except Exception:
            return ''
        if not text:
            return ''
        if 'UnicodeEncodeError' in text:
            return ('сервер упал с UnicodeEncodeError — его stdout не в UTF-8; '
                    'запустите его с PYTHONIOENCODING=utf-8')
        return text[-300:]

    def _read_message(self, deadline):
        """Достаёт из очереди ответ с нужным id. Таймаут честный: сервер,
        который просто молчит, не должен вешать вызов навсегда."""
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise McpError('превышено время ожидания ответа от «%s»' % self.name)
            try:
                data = self._queue.get(timeout=min(remaining, 0.5))
            except queue.Empty:
                if not self.is_running():
                    detail = self._stderr_tail()
                    raise McpError('сервер «%s» завершился (код %s)%s'
                                   % (self.name, self.proc.poll(),
                                      '. ' + detail if detail else ''))
                continue
            if data is None:          # EOF от потока-читателя
                detail = self._stderr_tail()
                raise McpError('сервер «%s» завершился (код %s)%s'
                               % (self.name, self.proc.poll(),
                                  '. ' + detail if detail else ''))
            if not isinstance(data, dict) or data.get('id') is None:
                continue          # асинхронное уведомление
            if data.get('id') != self._waiting_for:
                continue          # чужой ответ
            return data

    def request(self, method, params=None, timeout=None):
        """Один запрос-ответ под блокировкой (идентификаторы должны идти по порядку)."""
        with self._lock:
            deadline = time.monotonic() + (timeout or self.timeout)
            self._waiting_for = self._send(method, params)
            data = self._read_message(deadline)
            if data.get('error'):
                err = data['error']
                msg = err.get('message') if isinstance(err, dict) else str(err)
                raise McpError(str(msg))
            return data.get('result', {})

    def notify(self, method, params=None):
        with self._lock:
            self._send(method, params, notification=True)

    # ---------- MCP ----------
    def initialize(self):
        result = self.request('initialize', {
            'protocolVersion': PROTOCOL_VERSION,
            'capabilities': {},
            'clientInfo': CLIENT_INFO,
        })
        self.server_info = result.get('serverInfo', {}) or {}
        self.capabilities = result.get('capabilities', {}) or {}
        return result
    def handshake(self):
        """initialize + notifications/initialized. Идемпотентно."""
        if not self.is_running():
            self.start()
        self.initialize()
        try:
            self.notify('notifications/initialized')
        except McpError:
            pass  # не все серверы ждут это уведомление

    def list_tools(self):
        if not self.is_running():
            self.start()
        if not self.server_info:
            self.handshake()
        tools = []
        result = self.request('tools/list', {})
        tools.extend(result.get('tools', []) or [])
        cursor = result.get('nextCursor')
        while cursor and len(tools) < MAX_TOOLS_PER_SERVER:
            result = self.request('tools/list', {'cursor': cursor})
            tools.extend(result.get('tools', []) or [])
            cursor = result.get('nextCursor')
        return tools[:MAX_TOOLS_PER_SERVER]

    def call_tool(self, name, arguments=None, timeout=None):
        if not self.is_running():
            self.start()
        if not self.server_info:
            self.handshake()
        return self.request('tools/call', {'name': name, 'arguments': arguments or {}}, timeout)


# Максимальный ответ HTTP-сервера. Список инструментов Notion/Atlassian бывает
# крупным, но мегабайты — уже не сервер, а случайность.
HTTP_MAX_BYTES = 32 * 1024 * 1024


class McpHttpClient:
    """Удалённый MCP-сервер: JSON-RPC 2.0 поверх Streamable HTTP.

    Зачем он здесь
    --------------
    Часть MCP-серверов (Context7, Zapier, Notion, Atlassian) не существует
    как локальный пакет: это удалённые HTTP-эндпоинты. Ничего ставить не
    нужно, но нужен доступ в сеть — из браузера это сделать нельзя.

    Интерфейс намеренно совпадает с McpServerClient (request/notify/start/
    stop/handshake/list_tools/call_tool), поэтому Registry, server.py и UI о
    транспорте ничего не знают.

    Особенности протокола, которые здесь учтены:
      * ответ приходит либо application/json, либо потоком SSE
        (text/event-stream) — разбираем оба;
      * сервер выдаёт Mcp-Session-Id, его надо возвращать в следующих
        запросах; серверы без сессий его просто не присылают;
      * POST с уведомлением (без id) ждёт 202 Accepted с пустым телом —
        ответного сообщения там не бывает.

    Ограничение: OAuth-логин (Zapier/Notion/Atlassian) не реализован, нужен
    готовый статический токен в заголовке из конфига.
    """

    def __init__(self, name, url, headers=None, timeout=DEFAULT_TIMEOUT,
                 enabled=True):
        self.name = name
        self.url = url
        self.headers = dict(headers or {})
        self.timeout = timeout
        self.enabled = enabled
        self.transport = 'http'
        self.command = ''          # для общего интерфейса с UI
        self.args = []
        self.env = {}
        self.cwd = None
        self.next_id = 1
        self.server_info = {}
        self.capabilities = {}
        self.last_error = ''
        self._lock = threading.Lock()       # запросы строго по одному
        self._session_id = ''
        self._ready = False

    # ---------- жизненный цикл ----------
    def is_running(self):
        # Процесса нет: «жив» сервер ровно настолько, насколько отвечает.
        # Для UI достаточно — статус «работает» появляется после initialize.
        return self._ready

    def stop(self):
        with self._lock:
            self._ready = False
            self._session_id = ''

    def start(self):
        """У HTTP-транспорта поднимать нечего."""
        return

    # ---------- транспорт ----------
    def _base_headers(self):
        head = {
            'Content-Type': 'application/json',
            # Streamable HTTP требует оба типа в Accept: сервер сам решает,
            # прислать JSON или SSE-поток.
            'Accept': 'application/json, text/event-stream',
        }
        if self._session_id:
            head['Mcp-Session-Id'] = self._session_id
        head.update(self.headers)
        return head

    @staticmethod
    def _parse_sse(body):
        """Достаёт JSON-RPC-сообщения из потока SSE.

        Формат: строки «data: {...}», между событиями пустая строка. Нас
        интересует сообщение с 'id' — это и есть ответ на наш запрос.
        """
        result = None
        for raw in body.splitlines():
            line = raw.strip()
            if not line.startswith('data:'):
                continue
            payload = line[5:].strip()
            if not payload or payload == '[DONE]':
                continue
            try:
                msg = json.loads(payload)
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get('id') is not None:
                result = msg
        return result

    def _post(self, payload, timeout):
        body = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(self.url, data=body, method='POST',
                                     headers=self._base_headers())
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read(HTTP_MAX_BYTES + 1)
                session = (resp.headers.get('Mcp-Session-Id')
                           or resp.headers.get('mcp-session-id'))
                if session and not self._session_id:
                    self._session_id = session.strip()
                ctype = (resp.headers.get('Content-Type') or '').lower()
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read(2048).decode('utf-8', 'replace').strip()
            except Exception:
                pass
            if e.code in (401, 403):
                raise McpError('%s: сервер отклонил доступ (%d) — нужен верный токен '
                               'в headers конфига, OAuth-логина пока нет' % (self.name, e.code))
            raise McpError('%s: HTTP %d%s' % (self.name, e.code,
                                              (': ' + detail[:200]) if detail else ''))
        except urllib.error.URLError as e:
            raise McpError('%s: не удалось соединиться: %s' % (self.name, e.reason))
        except Exception as e:  # noqa: BLE001 — сеть умеет удивлять
            raise McpError('%s: %s' % (self.name, e))

        if len(raw) > HTTP_MAX_BYTES:
            raise McpError('%s: ответ слишком большой (больше %d МБ)'
                           % (self.name, HTTP_MAX_BYTES // 1048576))
        text = raw.decode('utf-8', 'replace').strip()
        if not text:
            return None                      # уведомление: 202 Accepted без тела
        if 'text/event-stream' in ctype or text.startswith('event:') or text.startswith('data:'):
            return self._parse_sse(text)
        try:
            return json.loads(text)
        except ValueError:
            # Часть серверов отдаёт SSE, забыв про Content-Type.
            parsed = self._parse_sse(text)
            if parsed is not None:
                return parsed
            raise McpError('%s: не понял ответ сервера' % self.name)

    # ---------- MCP ----------
    def request(self, method, params=None, timeout=None):
        with self._lock:
            message = {'jsonrpc': '2.0', 'id': self.next_id, 'method': method}
            self.next_id += 1
            if params is not None:
                message['params'] = params
            data = self._post(message, timeout or self.timeout)
        if data is None:
            raise McpError('%s: сервер не вернул ответ на %s' % (self.name, method))
        if data.get('error'):
            err = data['error']
            msg = err.get('message') if isinstance(err, dict) else str(err)
            raise McpError(str(msg))
        return data.get('result', {})

    def notify(self, method, params=None):
        with self._lock:
            message = {'jsonrpc': '2.0', 'method': method}
            if params is not None:
                message['params'] = params
            try:
                self._post(message, self.timeout)
            except McpError:
                pass  # не все серверы ждут это уведомление

    def initialize(self):
        result = self.request('initialize', {
            'protocolVersion': PROTOCOL_VERSION,
            'capabilities': {},
            'clientInfo': CLIENT_INFO,
        })
        self.server_info = result.get('serverInfo', {}) or {}
        self.capabilities = result.get('capabilities', {}) or {}
        return result

    def handshake(self):
        """initialize + notifications/initialized. Идемпотентно."""
        if self._ready and self.server_info:
            return
        self.initialize()
        self.notify('notifications/initialized')
        self._ready = True

    def list_tools(self):
        self.handshake()
        tools = []
        result = self.request('tools/list', {})
        tools.extend(result.get('tools', []) or [])
        cursor = result.get('nextCursor')
        while cursor and len(tools) < MAX_TOOLS_PER_SERVER:
            result = self.request('tools/list', {'cursor': cursor})
            tools.extend(result.get('tools', []) or [])
            cursor = result.get('nextCursor')
        return tools[:MAX_TOOLS_PER_SERVER]

    def call_tool(self, name, arguments=None, timeout=None):
        self.handshake()
        return self.request('tools/call', {'name': name, 'arguments': arguments or {}}, timeout)

DEFAULT_CONFIG = """{
  "servers": [
    { "name": "blender", "command": "uvx", "args": ["blender-mcp"], "enabled": false },
    { "name": "godot",   "command": "npx", "args": ["-y", "godot-mcp"], "enabled": false }
  ]
}
"""


def load_config(path):
    """Читает конфиг MCP-серверов. Отсутствие файла — не ошибка."""
    servers = []
    if not path or not os.path.exists(path):
        return servers
    try:
        with open(path, encoding='utf-8') as fh:
            data = json.load(fh)
    except (OSError, ValueError) as e:
        raise McpError('не удалось прочитать конфиг %s: %s' % (path, e))
    if isinstance(data, list):
        data = {'servers': data}
    if not isinstance(data, dict):
        raise McpError('конфиг должен быть объектом или списком серверов')
    for entry in (data.get('servers') or []):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get('name') or '').strip()
        if not name:
            continue
        # Транспорт выбирается по полю type, но если type не указан, а есть url —
        # считаем это http. Так коротче и нельзя ошибиться, забыв type.
        transport = str(entry.get('type') or '').strip().lower()
        url = str(entry.get('url') or '').strip()
        command = str(entry.get('command') or '').strip()
        if not transport:
            transport = 'http' if url else 'stdio'
        timeout = float(entry.get('timeout') or DEFAULT_TIMEOUT)
        enabled = bool(entry.get('enabled', True))
        if transport == 'http':
            if not url:
                raise McpError('сервер «%s»: транспорт http требует "url"' % name)
            if not url.lower().startswith(('http://', 'https://')):
                raise McpError('сервер «%s»: url должен начинаться с http:// или https://' % name)
            raw_headers = entry.get('headers') if isinstance(entry.get('headers'), dict) else {}
            headers = {str(k): str(v) for k, v in raw_headers.items()}
            # Не даём из конфига переписать технические заголовки протокола:
            # сломанный Accept или Content-Type ломает обмен целиком.
            for reserved in ('content-type', 'accept', 'host'):
                headers.pop(reserved, None)
                for k in [h for h in headers if h.lower() == reserved]:
                    headers.pop(k, None)
            servers.append(McpHttpClient(
                name=name, url=url, headers=headers,
                timeout=timeout, enabled=enabled,
            ))
            continue
        if not command:
            continue
        raw_env = entry.get('env') if isinstance(entry.get('env'), dict) else {}
        servers.append(McpServerClient(
            name=name, command=command,
            args=[str(a) for a in (entry.get('args') or [])],
            env={str(k): str(v) for k, v in raw_env.items()},
            cwd=str(entry['cwd']) if entry.get('cwd') else None,
            timeout=timeout,
            enabled=enabled,
        ))
    return servers


class Registry:
    """Все настроенные MCP-серверы и их состояние."""

    def __init__(self, config_path):
        self.config_path = config_path
        self.clients = {}
        self.errors = {}
        self.load_error = ''
        self.reload()

    def reload(self):
        self.stop_all()
        self.clients = {}
        self.errors = {}
        self.load_error = ''
        try:
            for client in load_config(self.config_path):
                self.clients[client.name] = client
        except McpError as e:
            self.load_error = str(e)

    def stop_all(self):
        for client in list(self.clients.values()):
            try:
                client.stop()
            except Exception:
                pass

    def describe(self):
        """Список серверов со статусом — для UI."""
        out = []
        for name in sorted(self.clients):
            client = self.clients[name]
            out.append({
                'name': name,
                'command': client.command,
                'args': client.args,
                # Транспорт и адрес нужны UI: у HTTP-сервера нет команды,
                # и без этого он выглядел бы «пустым» и сбивал с толку.
                'transport': getattr(client, 'transport', 'stdio'),
                'url': getattr(client, 'url', ''),
                'enabled': client.enabled,
                'running': client.is_running(),
                'error': self.errors.get(name, ''),
                'server_info': client.server_info,
            })
        return out

    def collect_tools(self):
        """Собирает инструменты всех включённых серверов.

        Ошибка одного сервера не должна ронять остальные: в UI показываем
        список доступных инструментов и отдельно — что сломалось.
        """
        tools = []
        for name in sorted(self.clients):
            client = self.clients[name]
            if not client.enabled:
                continue
            try:
                client.start()
                found = client.list_tools()
                self.errors[name] = ''
            except McpError as e:
                self.errors[name] = str(e)
                try:
                    client.stop()
                except Exception:
                    pass
                continue
            except Exception as e:  # noqa: BLE001 — сервер мог вернуть что угодно
                self.errors[name] = 'непредвиденная ошибка: %s' % e
                continue
            for tool in found:
                if not isinstance(tool, dict) or not tool.get('name'):
                    continue
                tools.append({
                    'server': name,
                    'name': tool.get('name'),
                    'title': tool.get('title') or '',
                    'description': tool.get('description') or '',
                    'inputSchema': tool.get('inputSchema') or {'type': 'object', 'properties': {}},
                })
        return tools

    def call(self, server, name, arguments=None, timeout=None):
        client = self.clients.get(server)
        if client is None:
            raise McpError('сервер «%s» не найден в конфиге' % server)
        if not client.enabled:
            raise McpError('сервер «%s» выключен' % server)
        try:
            return client.call_tool(name, arguments, timeout)
        except McpError as e:
            self.errors[server] = str(e)
            raise

    def shutdown(self):
        self.stop_all()