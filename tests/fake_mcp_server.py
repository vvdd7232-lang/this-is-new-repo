"""Тестовый MCP-сервер для юнит-тестов mcp_client (только stdio, без сети).

Проверяет ровно то, что делает настоящий MCP-сервер: initialize → tools/list
→ tools/call, мусор в stdout и падение по требованию.
"""
import json
import sys

# На Windows консоль по умолчанию cp1252 и падает на кириллице с
# UnicodeEncodeError — MCP требует UTF-8 в stdout, поэтому фиксируем явно.
try:
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

MODE = sys.argv[1] if len(sys.argv) > 1 else 'ok'
TOOLS = [
    {'name': 'create_cube', 'description': 'Создаёт куб',
     'inputSchema': {'type': 'object',
                     'properties': {'size': {'type': 'number'}}, 'required': ['size']}},
    {'name': 'boom', 'description': 'Всегда падает',
     'inputSchema': {'type': 'object', 'properties': {}}},
    {'name': 'hang', 'description': 'Не отвечает', 'inputSchema': {'type': 'object', 'properties': {}}},
]


def send(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main():
    if MODE == 'die':
        sys.stdout.write('не JSON вовсе\n')   # мусор в stdout перед стартом
        sys.stdout.flush()
        sys.exit(3)

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except ValueError:
            continue
        method = msg.get('method')
        rid = msg.get('id')

        if method == 'initialize':
            send({'jsonrpc': '2.0', 'id': rid, 'result': {
                'protocolVersion': '2024-11-05',
                'capabilities': {'tools': {}},
                'serverInfo': {'name': 'fake-' + MODE, 'version': '0.0.1'},
            }})
        elif method == 'tools/list':
            send({'jsonrpc': '2.0', 'id': rid, 'result': {'tools': TOOLS}})
        elif method == 'tools/call':
            name = (msg.get('params') or {}).get('name')
            if name == 'hang':
                continue                      # молчит — тест таймаута
            if name == 'boom':
                send({'jsonrpc': '2.0', 'id': rid,
                      'error': {'code': -32000, 'message': 'инструмент сломан'}})
            else:
                send({'jsonrpc': '2.0', 'id': rid, 'result': {
                    'content': [{'type': 'text',
                                 'text': 'сделано: %s %s' % (name, json.dumps(
                                     (msg.get('params') or {}).get('arguments', {}),
                                     ensure_ascii=False, sort_keys=True))}],
                    'isError': False,
                }})
        elif rid is not None:
            send({'jsonrpc': '2.0', 'id': rid, 'result': {}})


if __name__ == '__main__':
    main()