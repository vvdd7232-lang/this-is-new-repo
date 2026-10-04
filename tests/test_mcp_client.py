"""Тесты MCP-клиента: протокол, конфиг, отказоустойчивость, таймауты."""
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'server'))

import mcp_client as mcp  # noqa: E402

FAKE = [sys.executable, os.path.join(HERE, 'fake_mcp_server.py')]
SHIPPED = os.path.join(os.path.dirname(HERE), 'server', 'mcp_servers.json')


def make_client(mode='ok', **kwargs):
    return mcp.McpServerClient(name='fake', command=FAKE[0], args=FAKE[1:] + [mode], **kwargs)


class LoadConfigTests(unittest.TestCase):
    def test_missing_file_is_not_an_error(self):
        self.assertEqual(mcp.load_config(os.path.join(HERE, 'нет-такого.json')), [])

    def test_reads_servers(self):
        names = {c.name for c in mcp.load_config(SHIPPED)}
        self.assertIn('blender', names)
        self.assertIn('godot', names)

    def test_shipped_config_is_disabled_by_default(self):
        """MCP — экспериментальная функция: из коробки всё выключено."""
        for client in mcp.load_config(SHIPPED):
            self.assertFalse(client.enabled, '%s должен быть выключен' % client.name)

    def test_skips_entries_without_name_or_command(self):
        path = os.path.join(HERE, '_tmp_cfg.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump({'servers': [{'name': 'ok', 'command': 'x'}, {'command': 'y'},
                                  {'name': 'z'}, 'строка',
                                  {'name': 'a', 'command': 'b', 'args': [1, 2]}]}, fh)
        try:
            clients = mcp.load_config(path)
            self.assertEqual([c.name for c in clients], ['ok', 'a'])
            self.assertEqual(clients[1].args, ['1', '2'])
        finally:
            os.remove(path)

    def test_broken_json_raises_mcp_error(self):
        path = os.path.join(HERE, '_tmp_bad.json')
        with open(path, 'w', encoding='utf-8') as fh:
            fh.write('{это не json')
        try:
            with self.assertRaises(mcp.McpError):
                mcp.load_config(path)
        finally:
            os.remove(path)

    def test_list_form_is_accepted(self):
        path = os.path.join(HERE, '_tmp_list.json')
        with open(path, 'w', encoding='utf-8') as fh:
            json.dump([{'name': 'a', 'command': 'x'}], fh)
        try:
            self.assertEqual(len(mcp.load_config(path)), 1)
        finally:
            os.remove(path)


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.client = make_client()
        self.addCleanup(self.client.stop)

    def test_handshake_reports_server_info(self):
        self.client.handshake()
        self.assertTrue(self.client.is_running())
        self.assertEqual(self.client.server_info.get('name'), 'fake-ok')
        self.assertIn('tools', self.client.capabilities)

    def test_list_tools(self):
        tools = self.client.list_tools()
        self.assertEqual(len(tools), 3)
        self.assertEqual(tools[0]['name'], 'create_cube')

    def test_call_tool_returns_content(self):
        result = self.client.call_tool('create_cube', {'size': 2})
        text = result['content'][0]['text']
        self.assertIn('сделано', text)
        self.assertIn('create_cube', text)

    def test_server_error_becomes_mcp_error(self):
        with self.assertRaises(mcp.McpError) as ctx:
            self.client.call_tool('boom')
        self.assertIn('инструмент сломан', str(ctx.exception))

    def test_timeout(self):
        client = make_client(timeout=1.0)
        self.addCleanup(client.stop)
        with self.assertRaises(mcp.McpError) as ctx:
            client.call_tool('hang')
        self.assertIn('время ожидания', str(ctx.exception))

    def test_missing_command_is_readable(self):
        client = mcp.McpServerClient(name='x', command='нет-такой-команды-12345')
        with self.assertRaises(mcp.McpError) as ctx:
            client.start()
        self.assertIn('команда не найдена', str(ctx.exception))

    def test_dead_server_reports_exit_code(self):
        client = make_client('die')
        with self.assertRaises(mcp.McpError) as ctx:
            client.list_tools()
        self.assertIn('завершился', str(ctx.exception))
        client.stop()

    def test_stop_is_idempotent(self):
        client = make_client()
        client.start()
        client.stop()
        client.stop()  # не должно бросать
class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(HERE, '_tmp_reg.json')
        with open(self.path, 'w', encoding='utf-8') as fh:
            json.dump({'servers': [
                {'name': 'good', 'command': FAKE[0], 'args': FAKE[1:] + ['ok'], 'enabled': True},
                {'name': 'bad', 'command': 'нет-такой-команды-12345', 'enabled': True},
                {'name': 'off', 'command': FAKE[0], 'args': FAKE[1:], 'enabled': False},
            ]}, fh)
        self.reg = mcp.Registry(self.path)
        self.addCleanup(self.reg.shutdown)
        self.addCleanup(self._cleanup)

    def _cleanup(self):
        if os.path.exists(self.path):
            os.remove(self.path)

    def test_disabled_servers_are_not_started(self):
        tools = self.reg.collect_tools()
        self.assertTrue(tools)
        self.assertTrue(all(t['server'] == 'good' for t in tools))
        self.assertFalse(self.reg.clients['off'].is_running())

    def test_broken_server_does_not_break_others(self):
        self.reg.collect_tools()
        self.assertIn('команда не найдена', self.reg.errors['bad'])
        self.assertEqual(self.reg.errors['good'], '')

    def test_tools_carry_schema(self):
        tool = self.reg.collect_tools()[0]
        self.assertEqual(tool['inputSchema']['type'], 'object')
        self.assertIn('size', tool['inputSchema']['properties'])

    def test_describe_shape(self):
        self.reg.collect_tools()
        described = {s['name']: s for s in self.reg.describe()}
        self.assertEqual(set(described), {'good', 'bad', 'off'})
        self.assertTrue(described['good']['running'])
        self.assertFalse(described['off']['enabled'])
        self.assertIn('команда не найдена', described['bad']['error'])

    def test_call_unknown_server(self):
        with self.assertRaises(mcp.McpError) as ctx:
            self.reg.call('нет-такого', 'x')
        self.assertIn('не найден', str(ctx.exception))

    def test_call_disabled_server_is_refused(self):
        with self.assertRaises(mcp.McpError) as ctx:
            self.reg.call('off', 'create_cube')
        self.assertIn('выключен', str(ctx.exception))

    def test_call_dispatch(self):
        self.assertIn('content', self.reg.call('good', 'create_cube', {'size': 1}))

    def test_reload_after_config_change(self):
        with open(self.path, 'w', encoding='utf-8') as fh:
            json.dump({'servers': [{'name': 'fresh', 'command': FAKE[0],
                                    'args': FAKE[1:], 'enabled': True}]}, fh)
        self.reg.reload()
        self.assertEqual(list(self.reg.clients), ['fresh'])

    def test_bad_config_does_not_crash_registry(self):
        with open(self.path, 'w', encoding='utf-8') as fh:
            fh.write('не json')
        self.reg.reload()
        self.assertEqual(self.reg.clients, {})
        self.assertTrue(self.reg.load_error)


if __name__ == '__main__':
    unittest.main(verbosity=2)