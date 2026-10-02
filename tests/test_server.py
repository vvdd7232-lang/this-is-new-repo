#!/usr/bin/env python3
"""Тесты server.py: whitelist, smart_decode, _clip, normalize_whitespace, view.
Запуск из корня проекта:
    python tests/test_server.py
или
    python -m unittest tests.test_server
"""
import os
import sys
import unittest

# Импортируем server.py как модуль (лежит в ../server/)
ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, '..', 'server'))

import server  # noqa: E402


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


if __name__ == '__main__':
    unittest.main(verbosity=2)
