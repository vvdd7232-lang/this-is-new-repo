"""Тесты HTTP-транспорта MCP (Streamable HTTP) и загрузки конфига.

Зачем отдельный файл: stdio-проверки живут в test_mcp_client.py, а здесь нужен
настоящий HTTP-сокет (localhost), чтобы проверить не только разбор ответов,
но и заголовки, сессии и коды ошибок.

Особый акцент на последнем блоке: перечисленные серверы (context7, zapier,
notion, playwright и прочие) НЕ должны появляться в поставляемом конфиге.
Поддержка transport'а добавлена, но включать что-то без спроса пользователя
нельзя — это отдельное решение.
"""
import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'server'))

import mcp_client as mcp  # noqa: E402

SHIPPED = os.path.join(os.path.dirname(HERE), 'server', 'mcp_servers.json')

TOOLS = [{'name': 'resolve-library-id', 'description': 'Ищет библиотеку',
          'inputSchema': {'type': 'object', 'properties': {'name': {'type': 'string'}}}},
         {'name': 'get-library-docs', 'description': 'Отдаёт документацию',
          'inputSchema': {'type': 'object', 'properties': {'id': {'type': 'string'}}}}]


class Handler(BaseHTTPRequestHandler):
    """Подставной MCP-сервер: JSON, SSE, сессии и 401 по разным путям."""

    protocol_version = 'HTTP/1.1'
    seen = []          # заголовки и тела всех запросов — для проверок

    def log_message(self, *args):
        pass

    def _json(self, payload, session=True, code=200):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        if session:
            self.send_header('Mcp-Session-Id', 'sess-42')
        self.end_headers()
        self.wfile.write(body)

    def _sse(self, payload):
        body = ('event: message\ndata: ' + json.dumps(payload) + '\n\n').encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _empty(self):
        self.send_response(202)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_GET(self):
        if self.path == '/tools':
            self._sse({'jsonrpc': '2.0', 'id': 99, 'result': {'tools': TOOLS}})
            return
        self._json({'error': 'метод не поддерживается'}, session=False, code=405)

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length).decode('utf-8')
        Handler.seen.append({'path': self.path, 'headers': dict(self.headers), 'raw': raw})
        msg = json.loads(raw) if raw else {}

        if self.path == '/unauth':
            self._json({'error': 'no'}, session=False, code=401)
            return

        method = msg.get('method')
        if method == 'initialize':
            self._json({'jsonrpc': '2.0', 'id': msg.get('id'),
                        'result': {'protocolVersion': '2024-11-05',
                                   'serverInfo': {'name': 'fake-http', 'version': '9.9'},
                                   'capabilities': {'tools': {}}}})
            return
        if msg.get('id') is None:          # уведомление
            self._empty()
            return
        if method == 'tools/list':
            if self.path == '/sse':
                self._sse({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'tools': TOOLS}})
                return
            self._json({'jsonrpc': '2.0', 'id': msg['id'], 'result': {'tools': TOOLS}})
            return
        if method == 'tools/call':
            self._json({'jsonrpc': '2.0', 'id': msg['id'],
                        'result': {'content': [{'type': 'text', 'text': 'ответ сервера'}]}})
            return
        if method == 'boom':
            self._json({'jsonrpc': '2.0', 'id': msg['id'],
                        'error': {'code': -32000, 'message': 'инструмент сломан'}})
            return
        self._json({'jsonrpc': '2.0', 'id': msg.get('id'), 'result': {}})


class HttpServerFixture(object):
    """Поднимает подставной сервер на localhost и гасит его после тестов."""

    def __enter__(self):
        Handler.seen = []
        self.httpd = HTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = 'http://127.0.0.1:%d' % self.httpd.server_address[1]
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        return False


class ConfigTransportTests(unittest.TestCase):
    def _write(self, data):
        path = os.path.join(HERE, '_tmp_http_cfg.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump(data, fh)
        return path

    def test_type_http_creates_http_client(self):
        path = self._write({'servers': [
            {'name': 'ctx7', 'type': 'http', 'url': 'https://mcp.context7.com/mcp'}]})
        try:
            clients = mcp.load_config(path)
            self.assertEqual(len(clients), 1)
            self.assertIsInstance(clients[0], mcp.McpHttpClient)
            self.assertEqual(clients[0].transport, 'http')
            self.assertEqual(clients[0].url, 'https://mcp.context7.com/mcp')
        finally:
            os.remove(path)

    def test_url_without_type_is_treated_as_http(self):
        path = self._write({'servers': [{'name': 'x', 'url': 'https://example.com/mcp'}]})
        try:
            self.assertEqual(mcp.load_config(path)[0].transport, 'http')
        finally:
            os.remove(path)

    def test_command_without_type_stays_stdio(self):
        path = self._write({'servers': [{'name': 'x', 'command': 'npx'}]})
        try:
            clients = mcp.load_config(path)
            self.assertIsInstance(clients[0], mcp.McpServerClient)
            self.assertEqual(clients[0].transport, 'stdio')
        finally:
            os.remove(path)

    def test_http_without_url_is_rejected(self):
        path = self._write({'servers': [{'name': 'bad', 'type': 'http'}]})
        try:
            with self.assertRaises(mcp.McpError) as ctx:
                mcp.load_config(path)
            self.assertIn('url', str(ctx.exception))
        finally:
            os.remove(path)

    def test_url_scheme_is_checked(self):
        path = self._write({'servers': [{'name': 'bad', 'type': 'http', 'url': 'ftp://x/mcp'}]})
        try:
            with self.assertRaises(mcp.McpError):
                mcp.load_config(path)
        finally:
            os.remove(path)

    def test_protocol_headers_cannot_be_overridden(self):
        """Из конфига нельзя сломать Content-Type/Accept — обмен отвалится."""
        path = self._write({'servers': [{
            'name': 'x', 'type': 'http', 'url': 'https://example.com/mcp',
            'headers': {'Content-Type': 'text/plain', 'Accept': 'text/html',
                        'Authorization': 'Bearer secret'}}]})
        try:
            client = mcp.load_config(path)[0]
            keys = {k.lower() for k in client.headers}
            self.assertNotIn('content-type', keys)
            self.assertNotIn('accept', keys)
            self.assertIn('authorization', keys)
            head = {k.lower(): v for k, v in client._base_headers().items()}
            self.assertEqual(head['content-type'], 'application/json')
            self.assertIn('text/event-stream', head['accept'])
            self.assertEqual(head['authorization'], 'Bearer secret')
        finally:
            os.remove(path)


class HttpProtocolTests(unittest.TestCase):
    def test_full_cycle_json(self):
        with HttpServerFixture() as fx:
            client = mcp.McpHttpClient(name='ctx7', url=fx.base + '/mcp')
            tools = client.list_tools()
            self.assertEqual([t['name'] for t in tools],
                             ['resolve-library-id', 'get-library-docs'])
            self.assertEqual(client.server_info.get('name'), 'fake-http')
            result = client.call_tool('get-library-docs', {'id': 'react'})
            self.assertEqual(result['content'][0]['text'], 'ответ сервера')
            self.assertTrue(client.is_running())

    def test_session_id_is_remembered_and_returned(self):
        with HttpServerFixture() as fx:
            client = mcp.McpHttpClient(name='ctx7', url=fx.base + '/mcp')
            client.list_tools()
            self.assertEqual(client._session_id, 'sess-42')
            later = [r for r in Handler.seen if r['raw'] and 'tools/list' in r['raw']]
            self.assertTrue(later)
            self.assertEqual(later[-1]['headers'].get('Mcp-Session-Id'), 'sess-42')

    def test_accept_header_asks_for_both_types(self):
        with HttpServerFixture() as fx:
            client = mcp.McpHttpClient(name='x', url=fx.base + '/mcp')
            client.list_tools()
            accept = Handler.seen[0]['headers'].get('Accept', '')
            self.assertIn('application/json', accept)
            self.assertIn('text/event-stream', accept)

    def test_sse_response_is_parsed(self):
        with HttpServerFixture() as fx:
            client = mcp.McpHttpClient(name='x', url=fx.base + '/sse')
            self.assertEqual(len(client.list_tools()), 2)

    def test_notification_does_not_expect_a_body(self):
        with HttpServerFixture() as fx:
            client = mcp.McpHttpClient(name='x', url=fx.base + '/mcp')
            client.handshake()          # включает notifications/initialized
            self.assertTrue(client.is_running())

    def test_tool_error_is_reported(self):
        with HttpServerFixture() as fx:
            client = mcp.McpHttpClient(name='x', url=fx.base + '/mcp')
            client.handshake()
            with self.assertRaises(mcp.McpError) as ctx:
                client.request('boom')
            self.assertIn('инструмент сломан', str(ctx.exception))

    def test_unauthorized_explains_about_token(self):
        with HttpServerFixture() as fx:
            client = mcp.McpHttpClient(name='notion', url=fx.base + '/unauth')
            with self.assertRaises(mcp.McpError) as ctx:
                client.list_tools()
            self.assertIn('токен', str(ctx.exception))

    def test_connection_refused_is_readable(self):
        client = mcp.McpHttpClient(name='dead', url='http://127.0.0.1:9/mcp')
        with self.assertRaises(mcp.McpError) as ctx:
            client.list_tools()
        self.assertIn('dead', str(ctx.exception))

    def test_sse_parser_takes_message_with_id(self):
        body = ('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/x"}\n\n'
                'event: message\ndata: {"jsonrpc":"2.0","id":5,"result":{"ok":true}}\n\n')
        parsed = mcp.McpHttpClient._parse_sse(body)
        self.assertEqual(parsed['id'], 5)
        self.assertTrue(parsed['result']['ok'])


class ShippedConfigTests(unittest.TestCase):
    """Поставляемый конфиг не должен включать серверы за пользователя.

    Пользователь попросил добавить поддержку каталога MCP-серверов, но НЕ
    прописывать их в конфиг. Проверяется именно закоммиченная версия файла:
    локальную копию пользователь меняет сознательно (сам включает нужные
    серверы), а в поставку должно уезжать пустое. Иначе тест врал бы тем, кто
    уже всё настроил под себя.
    """

    @classmethod
    def setUpClass(cls):
        import subprocess
        try:
            out = subprocess.check_output(
                ['git', 'show', 'HEAD:server/mcp_servers.json'],
                cwd=os.path.dirname(HERE), stderr=subprocess.DEVNULL)
            cls.data = json.loads(out.decode('utf-8'))
        except Exception:
            raise unittest.SkipTest('git недоступен или файл не закоммичен')
        if not isinstance(cls.data, dict):
            cls.data = {'servers': cls.data}

    def test_no_preinstalled_catalog_servers(self):
        names = {str(s.get('name', '')).lower() for s in self.data.get('servers', [])}
        # filesystem в поставляемом конфиге был ДО этого изменения (выключенный,
        # как и остальные) — его не проверяем, иначе тест врал бы о текущем
        # состоянии репозитория. Задача теста — не дать добавить новые серверы
        # из каталога молча.
        forbidden = {
            'sequential-thinking', 'sequentialthinking', 'github', 'gitlab',
            'brave-search', 'duckduckgo', 'context7', 'firecrawl', 'memory',
            'memory-bank', 'playwright', 'puppeteer', 'chrome-devtools',
            'chrome', 'zapier', 'notion', 'jira', 'atlassian',
        }
        self.assertEqual(names & forbidden, set(),
                         'в поставляемом конфиге не должно быть серверов из каталога')

    def test_catalog_servers_count_did_not_grow(self):
        """Страховка от «новых» серверов под другими именами (fs-server и т.п.)."""
        names = {str(s.get('name', '')).lower() for s in self.data.get('servers', [])}
        self.assertLessEqual(len(names), 3,
                             'в поставляемом конфиге должно остаться не больше трёх серверов')

    def test_shipped_config_has_no_http_urls(self):
        """HTTP-серверы ходят в интернет — их нельзя включать молча."""
        for entry in self.data.get('servers', []):
            self.assertFalse(entry.get('url'), 'в поставляемом конфиге не должно быть url')
            self.assertNotEqual(str(entry.get('type', '')).lower(), 'http')


if __name__ == '__main__':
    unittest.main()