#!/usr/bin/env python3
"""Тесты server.py: whitelist, smart_decode, _clip, normalize_whitespace, view.
Запуск из корня проекта:
    python tests/test_server.py
или
    python -m unittest tests.test_server
"""
import json
import os
import sys
import unittest

# Импортируем server.py как модуль (лежит в ../server/)
ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, '..', 'server'))

import server  # noqa: E402
import mcp_client  # noqa: E402


class TestNormalizeWhitespace(unittest.TestCase):
    def test_nbsp_to_space(self):
        self.assertEqual(server.normalize_whitespace('a\u00a0b'), 'a b')

    def test_en_em_space(self):
        self.assertEqual(server.normalize_whitespace('a\u2003b'), 'a b')

    def test_zero_width_removed(self):
        self.assertEqual(server.normalize_whitespace('a\u200bb\ufeffc'), 'abc')

    def test_empty(self):
        self.assertEqual(server.normalize_whitespace(''), '')
        self.assertIsNone(server.normalize_whitespace(None))

    def test_normal_text_unchanged(self):
        self.assertEqual(server.normalize_whitespace('ls -la'), 'ls -la')


class TestSmartDecode(unittest.TestCase):
    def test_utf8_cyrillic(self):
        self.assertEqual(server.smart_decode('привет'.encode('utf-8')), 'привет')

    def test_empty(self):
        self.assertEqual(server.smart_decode(b''), '')
        self.assertEqual(server.smart_decode(None), '')

    def test_str_passthrough(self):
        self.assertEqual(server.smart_decode('уже строка'), 'уже строка')

    def test_cp866_cyrillic(self):
        # Строка в cp866 без валидного UTF-8 — должна распознаться как cp866/cp1251
        raw = 'привет'.encode('cp866')
        out = server.smart_decode(raw)
        self.assertIn('привет', out)

    def test_mixed_buffer(self):
        # cmd (cp866) + node/python (utf-8) в одном буфере
        raw = 'привет'.encode('cp866') + b'\n' + 'мир'.encode('utf-8')
        out = server.smart_decode(raw)
        self.assertIn('привет', out)
        self.assertIn('мир', out)

    def test_readable_score(self):
        # UTF-8 кириллица должна получать больше очков, чем мусор
        s_ok = server._readable_score('привет мир')
        s_bad = server._readable_score('\ufffd\ufffd\ufffd')
        self.assertGreater(s_ok, s_bad)


class TestClip(unittest.TestCase):
    def test_under_limit(self):
        text, trunc = server._clip('hello')
        self.assertEqual(text, 'hello')
        self.assertFalse(trunc)

    def test_over_limit(self):
        server.MAX_OUTPUT = 5
        try:
            text, trunc = server._clip('hello world')
            self.assertTrue(trunc)
            self.assertLessEqual(len(text.encode('utf-8')), 5)
        finally:
            server.MAX_OUTPUT = 1_000_000

    def test_zero_means_unlimited(self):
        server.MAX_OUTPUT = 0
        try:
            big = 'x' * 100000
            text, trunc = server._clip(big)
            self.assertEqual(len(text), 100000)
            self.assertFalse(trunc)
        finally:
            server.MAX_OUTPUT = 1_000_000


class TestWhitelist(unittest.TestCase):
    def setUp(self):
        server.WHITELIST = frozenset({'ls', 'git status', 'python'})

    def tearDown(self):
        server.WHITELIST = None

    def test_exact_match(self):
        ok, _ = server._check_whitelist('ls')
        self.assertTrue(ok)

    def test_prefix_with_args(self):
        ok, _ = server._check_whitelist('ls -la')
        self.assertTrue(ok)

    def test_prefix_with_path(self):
        ok, _ = server._check_whitelist('ls /tmp')
        self.assertTrue(ok)

    def test_not_prefix_lsfoo(self):
        ok, reason = server._check_whitelist('lsfoo')
        self.assertFalse(ok)

    def test_git_status_ok(self):
        ok, _ = server._check_whitelist('git status -s')
        self.assertTrue(ok)

    def test_git_push_blocked(self):
        ok, reason = server._check_whitelist('git push')
        self.assertFalse(ok)

    def test_chain_blocked(self):
        ok, reason = server._check_whitelist('ls && rm -rf /')
        self.assertFalse(ok)
        self.assertIn('metacharacter', reason)

    def test_pipe_blocked(self):
        ok, _ = server._check_whitelist('ls | grep foo')
        self.assertFalse(ok)

    def test_subshell_blocked(self):
        ok, _ = server._check_whitelist('echo $(whoami)')
        self.assertFalse(ok)

    def test_empty_blocked(self):
        ok, _ = server._check_whitelist('')
        self.assertFalse(ok)

    def test_disabled_whitelist_allows_everything(self):
        server.WHITELIST = None
        ok, _ = server._check_whitelist('rm -rf /')
        self.assertTrue(ok)

    # --- регрессия v2.6.1: перевод строки больше не обходит whitelist ---
    def test_newline_after_allowed_prefix_blocked(self):
        ok, reason = server._check_whitelist('cd .\nrm -rf /tmp/x')
        self.assertFalse(ok)
        self.assertIn('metacharacter', reason)

    def test_crlf_after_allowed_prefix_blocked(self):
        ok, _ = server._check_whitelist('ls\r\nrm -rf /')
        self.assertFalse(ok)

    def test_bare_newline_blocked(self):
        ok, _ = server._check_whitelist('ls\nwhoami')
        self.assertFalse(ok)

    def test_plain_multiline_without_allowed_prefix_blocked(self):
        ok, _ = server._check_whitelist('python\nrm -rf /')
        self.assertFalse(ok)


class TestWhitelistCoversView(unittest.TestCase):
    """view читает файлы с диска — в whitelist-режиме он тоже должен быть ограничен."""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        self.tmp.write(bytes.fromhex(
            '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
            '890000000d4944415478da63f8cf00000003000100c9c59b7a0000000049454e'
            '44ae426082'))
        self.tmp.close()

    def tearDown(self):
        server.WHITELIST = None
        try:
            os.unlink(self.tmp.name)
        except OSError:
            pass

    def test_view_allowed_when_whitelist_off(self):
        server.WHITELIST = None
        r = server.execute({'command': 'view ' + self.tmp.name, 'runner': 'shell'})
        self.assertTrue(r.get('ok'))
        self.assertIn('view', r)

    def test_view_blocked_when_whitelist_on(self):
        server.WHITELIST = frozenset({'ls'})
        r = server.execute({'command': 'view ' + self.tmp.name, 'runner': 'shell'})
        self.assertFalse(r.get('ok'))
        self.assertTrue(r.get('blocked'))
        self.assertIn('whitelist', r.get('error', ''))

    def test_view_allowed_when_prefix_whitelisted(self):
        server.WHITELIST = frozenset({'view'})
        r = server.execute({'command': 'view ' + self.tmp.name, 'runner': 'shell'})
        self.assertTrue(r.get('ok'))
        self.assertIn('view', r)


class TestCorsHeaders(unittest.TestCase):
    """CORS не должен отдавать wildcard: только проверенный Origin."""

    def _headers_for(self, origin):
        import http.client
        import threading
        from http.server import ThreadingHTTPServer

        srv = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        srv.daemon_threads = True
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            conn = http.client.HTTPConnection('127.0.0.1', srv.server_address[1], timeout=5)
            conn.request('OPTIONS', '/run', headers={'Origin': origin, 'Host': '127.0.0.1'})
            resp = conn.getresponse()
            resp.read()
            return resp.status, {k.lower(): v for k, v in resp.getheaders()}
        finally:
            srv.shutdown()
            srv.server_close()

    def test_local_origin_is_echoed_not_wildcard(self):
        status, headers = self._headers_for('http://127.0.0.1:3000')
        self.assertEqual(status, 204)
        self.assertEqual(headers.get('access-control-allow-origin'), 'http://127.0.0.1:3000')
        self.assertNotEqual(headers.get('access-control-allow-origin'), '*')

    def test_foreign_origin_forbidden(self):
        status, _ = self._headers_for('https://evil.example')
        self.assertEqual(status, 403)

    def test_extension_origin_allowed(self):
        status, headers = self._headers_for('chrome-extension://abcdefghijklmnop')
        self.assertEqual(status, 204)
        self.assertEqual(headers.get('access-control-allow-origin'),
                         'chrome-extension://abcdefghijklmnop')


class TestMcpEndpoints(unittest.TestCase):
    """Эндпоинты /mcp/*. Важно: MCP выключен по умолчанию и закрыт токеном
    так же, как /run — иначе это была бы новая дыра в безопасности."""

    def setUp(self):
        self._saved = (server.MCP_REGISTRY, server.AUTH_TOKEN)
        server.AUTH_TOKEN = None
        server.MCP_REGISTRY = None
        import http.client
        import threading
        from http.server import ThreadingHTTPServer
        self.http = http.client
        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.port = self.srv.server_address[1]
        self._cleanup_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_tmp_http.json')
        with open(self._cleanup_path, 'w', encoding='utf-8') as fh:
            json.dump({'servers': [
                {'name': 'fake', 'command': sys.executable,
                 'args': [os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                       'fake_mcp_server.py'), 'ok'],
                 'enabled': True}]}, fh)
        server.MCP_REGISTRY = mcp_client.Registry(self._cleanup_path)

    def tearDown(self):
        if server.MCP_REGISTRY is not None:
            server.MCP_REGISTRY.shutdown()
        server.MCP_REGISTRY, server.AUTH_TOKEN = self._saved
        self.srv.shutdown()
        self.srv.server_close()
        if os.path.exists(self._cleanup_path):
            os.remove(self._cleanup_path)

    def _req(self, method, path, body=None, token=None):
        headers = {'Host': '127.0.0.1'}
        if token:
            headers['X-Auth-Token'] = token
        payload = None
        if body is not None:
            payload = json.dumps(body)
            headers['Content-Type'] = 'application/json'
        conn = self.http.HTTPConnection('127.0.0.1', self.port, timeout=30)
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        conn.close()
        return resp.status, json.loads(raw.decode('utf-8'))

    def test_mcp_disabled_by_default(self):
        server.MCP_REGISTRY = None
        status, data = self._req('POST', '/mcp/tools')
        self.assertEqual(status, 400)
        self.assertFalse(data['ok'])
        self.assertIn('--mcp', data['error'])

    def test_servers_status(self):
        status, data = self._req('GET', '/mcp/servers')
        self.assertEqual(status, 200)
        self.assertTrue(data['enabled'])
        self.assertEqual(data['servers'][0]['name'], 'fake')

    def test_tools_listing(self):
        status, data = self._req('POST', '/mcp/tools')
        self.assertEqual(status, 200)
        self.assertEqual(data['count'], 3)
        self.assertEqual(data['tools'][0]['server'], 'fake')

    def test_call_tool(self):
        status, data = self._req('POST', '/mcp/call',
                                 {'server': 'fake', 'tool': 'create_cube', 'arguments': {'size': 3}})
        self.assertEqual(status, 200)
        self.assertTrue(data['ok'])
        self.assertIn('сделано', data['result']['content'][0]['text'])

    def test_call_unknown_server_is_400(self):
        status, data = self._req('POST', '/mcp/call', {'server': 'нет', 'tool': 'x'})
        self.assertEqual(status, 400)
        self.assertIn('не найден', data['error'])

    def test_call_requires_fields(self):
        status, data = self._req('POST', '/mcp/call', {'server': 'fake'})
        self.assertEqual(status, 400)
        self.assertIn('server и tool', data['error'])

    def test_call_rejects_non_object_arguments(self):
        status, data = self._req('POST', '/mcp/call',
                                 {'server': 'fake', 'tool': 'create_cube', 'arguments': 'нет'})
        self.assertEqual(status, 400)
        self.assertIn('объектом', data['error'])

    def test_token_is_required(self):
        # Токен ASCII-ный намеренно: заголовки HTTP кодируются latin-1, и
        # не-ASCII токен упал бы ещё на отправке, не проверив саму защиту.
        server.AUTH_TOKEN = 'secret-token-123'
        for method, path, body in (('POST', '/mcp/tools', {}),
                                   ('POST', '/mcp/call', {'server': 'fake', 'tool': 'create_cube'}),
                                   ('POST', '/mcp/reload', {}),
                                   ('GET', '/mcp/servers', None)):
            status, data = self._req(method, path, body)
            self.assertEqual(status, 401, '%s %s должен требовать токен' % (method, path))
            self.assertFalse(data['ok'])

    def test_wrong_token_rejected(self):
        server.AUTH_TOKEN = 'secret-token-123'
        status, _ = self._req('POST', '/mcp/tools', {}, token='wrong-token')
        self.assertEqual(status, 401)

    def test_correct_token_accepted(self):
        server.AUTH_TOKEN = 'secret-token-123'
        status, data = self._req('POST', '/mcp/tools', {}, token='secret-token-123')
        self.assertEqual(status, 200)
        self.assertTrue(data['ok'])

    def test_reload(self):
        status, data = self._req('POST', '/mcp/reload')
        self.assertEqual(status, 200)
        self.assertEqual(data['servers'][0]['name'], 'fake')

    def test_unknown_endpoint_still_404(self):
        status, _ = self._req('POST', '/mcp/nope')
        self.assertEqual(status, 404)


class TestMcpStartupPrompt(unittest.TestCase):
    """Интерактивный выбор MCP при запуске сервера.

    Главное, что тут проверяется: сервер часто стартует из ярлыка или автозагрузки,
    где stdin — не терминал. Там вопрос обязан молча пропускаться, иначе сервер
    зависнет навсегда на input().
    """

    SHIPPED = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server', 'mcp_servers.json')

    def _call(self, answers, tty=True, cfg=None):
        """Вызывает _prompt_mcp с подменённым stdin. answers — что «введёт» юзер."""
        import builtins

        saved_stdin = server.sys.stdin
        asked = []

        class FakeStdin:
            def __init__(self, is_tty):
                self._tty = is_tty

            def isatty(self):
                return self._tty

            def readline(self):
                return ''

        try:
            server.sys.stdin = FakeStdin(tty)
            real_input = builtins.input

            def fake_input(prompt=''):
                asked.append(prompt)
                if not answers:
                    raise EOFError
                return answers.pop(0)

            builtins.input = fake_input
            return server._prompt_mcp(cfg or self.SHIPPED), asked
        finally:
            server.sys.stdin = saved_stdin
            builtins.input = real_input

    def test_no_tty_skips_question_entirely(self):
        result, asked = self._call(['y'], tty=False)
        self.assertFalse(result, 'без терминала MCP обязан остаться выключенным')
        self.assertEqual(asked, [], 'вопрос не должен задаваться без терминала')

    def test_yes_enables(self):
        result, asked = self._call(['y'])
        self.assertTrue(result)
        self.assertTrue(asked and 'MCP' in asked[0])

    def test_russian_yes_is_understood(self):
        self.assertTrue(self._call(['да'])[0])

    def test_no_disables(self):
        self.assertFalse(self._call(['n'])[0])

    def test_empty_answer_defaults_to_no(self):
        # Ответ по умолчанию — «нет»: экспериментальное не должно включаться
        # случайно, если пользователь просто нажал Enter.
        self.assertFalse(self._call([''])[0])

    def test_garbage_disables(self):
        self.assertFalse(self._call(['возможно'])[0])

    def test_eof_disables(self):
        self.assertFalse(self._call([])[0], 'Ctrl+D в терминале — это отказ, а не включение')

    def test_prompt_does_not_modify_config(self):
        """Выбор влияет только на текущий запуск: конфиг пользователя не трогаем."""
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_tmp_prompt.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump({'servers': [{'name': 'a', 'command': 'x', 'enabled': False}]}, fh)
        before = open(path, encoding='utf-8').read()
        try:
            self._call(['y'], cfg=path)
            self.assertEqual(open(path, encoding='utf-8').read(), before)
        finally:
            os.remove(path)

    def test_empty_config_reports_nothing_to_enable(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_tmp_empty.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump({'servers': []}, fh)
        try:
            result, asked = self._call(['y'], cfg=path)
            self.assertFalse(result)
            self.assertEqual(asked, [], 'пустой конфиг — вопрос бессмыслен')
        finally:
            os.remove(path)

    def test_broken_config_does_not_crash(self):
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_tmp_broken.json')
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write('не json')
        try:
            self.assertFalse(self._call(['y'], cfg=path)[0])
        finally:
            os.remove(path)

    def test_flag_priority_in_main(self):
        """--mcp / --no-mcp сильнее вопроса, --yes отвечает «да» без терминала."""
        src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..',
                                'server', 'server.py'), encoding='utf-8').read()
        self.assertIn("add_argument('--mcp'", src)
        self.assertIn("add_argument('--no-mcp'", src)
        self.assertIn("add_argument('--yes'", src)
        # Порядок: явное включение, явный отказ, авто-да, иначе вопрос.
        self.assertRegex(src, r'if args\.mcp:\s*\n\s*want_mcp = True')
        self.assertRegex(src, r'elif args\.no_mcp:\s*\n\s*want_mcp = False')
        self.assertRegex(src, r'elif args\.yes:\s*\n\s*want_mcp = True')
        self.assertRegex(src, r'else:\s*\n\s*want_mcp = _prompt_mcp\(_mcp_cfg\)')


class TestHandleView(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        # минимальный PNG (1x1)
        self.tmp.write(bytes.fromhex(
            '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4'
            '890000000d4944415478da63f8cf00000003000100c9c59b7a0000000049454e'
            '44ae426082'))
        self.tmp.close()

    def tearDown(self):
        try:
            os.unlink(self.tmp.name)
        except OSError:
            pass

    def test_view_png_ok(self):
        r = server._handle_view(self.tmp.name)
        self.assertTrue(r['ok'])
        self.assertTrue(r['view']['data_url'].startswith('data:image/png;base64,'))

    def test_view_empty_path(self):
        r = server._handle_view('')
        self.assertFalse(r['ok'])

    def test_view_not_found(self):
        r = server._handle_view('C:/nonexistent/nope.png')
        self.assertFalse(r['ok'])

    def test_view_non_image(self):
        import tempfile
        t = tempfile.NamedTemporaryFile(suffix='.txt', delete=False)
        t.write(b'hello')
        t.close()
        try:
            r = server._handle_view(t.name)
            self.assertFalse(r['ok'])
            self.assertIn('not an image', r['error'])
        finally:
            os.unlink(t.name)


class TestVersion(unittest.TestCase):
    def test_version_string(self):
        self.assertIsInstance(server.VERSION, str)
        self.assertGreater(len(server.VERSION), 0)

    def test_version_matches_manifests(self):
        """Версия сервера и расширения не должны расходиться — иначе бейдж и
        диагностика вводят в заблуждение (раньше тест проверял только тип)."""
        import json
        root = os.path.join(ROOT, '..')
        with open(os.path.join(root, 'extension', 'manifest.json'), encoding='utf-8') as f:
            ff = json.load(f)['version']
        with open(os.path.join(root, 'extension', 'manifest.chrome.json'), encoding='utf-8') as f:
            cr = json.load(f)['version']
        self.assertEqual(server.VERSION, ff)
        self.assertEqual(server.VERSION, cr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
