/* Тесты перевода ошибок в понятный текст (describeFailure).
 *
 * Живой случай из TROUBLESHOOTING: PowerShell на ненайденный путь отдаёт
 * exit=0 и пишет причину только в stderr. Раньше пользователь видел «✅ exit=0»
 * и пустой вывод; теперь под статусом появляется «Путь не найден» с подсказкой.
 *
 * Запуск:  cd tests && npm test
 */
'use strict';

const assert = require('assert');
const path = require('path');

const { describeFailure } = require(path.join(__dirname, '..', 'extension', 'ax-detector.js'));

let passed = 0;
let failed = 0;
const fails = [];

function check(name, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    fails.push(name);
    console.log('  ✗ ' + name + ' — получено ' + JSON.stringify(actual) + ', ожидалось ' + JSON.stringify(expected));
  }
}

function idOf(payload) {
  const r = describeFailure(payload);
  return r ? r.id : null;
}

console.log('\nуспешное выполнение — объяснять нечего:');
check('exit=0 без вывода', idOf({ exit_code: 0, stdout: '', stderr: '' }), null);
check('exit=0 с выводом', idOf({ exit_code: 0, stdout: 'готово', stderr: '' }), null);

console.log('\nтаймаут:');
check('timed_out', idOf({ exit_code: 124, timed_out: true, stdout: 'x', stderr: '[TIMEOUT 30s]' }), 'timeout');
check('только код 124', idOf({ exit_code: 124, stderr: '' }), 'timeout');

console.log('\nкоманда не найдена:');
check('Windows cmd', idOf({ exit_code: 1, stderr: "'gti' is not recognized as an internal or external command,\noperable program or batch file." }), 'unknown-command-windows');
check('bash', idOf({ exit_code: 127, stderr: 'bash: line 1: xyz: command not found' }), 'unknown-command-unix');

console.log('\nпути и файлы:');
check('PowerShell при exit=0 (!)',
  idOf({ exit_code: 0, stderr: "Get-Content : Cannot find path 'C:\\projects\\nope.txt' because it does not exist." }),
  'path-not-found-ps');
check('ENOENT в Node',
  idOf({ exit_code: 1, stderr: "Error: ENOENT: no such file or directory, open 'nope.txt'" }),
  'file-not-found-generic');

console.log('\nправа доступа:');
check('Windows', idOf({ exit_code: 1, stderr: "Access to the path 'C:\\Windows\\hosts' is denied." }), 'permission');
check('Unix', idOf({ exit_code: 1, stderr: 'Error: EACCES: permission denied, open /etc/shadow' }), 'permission');

console.log('\nPython:');
check('NameError', idOf({ exit_code: 1, stderr: "NameError: name 'x' is not defined" }), 'python-name');
check('ModuleNotFoundError', idOf({ exit_code: 1, stderr: "ModuleNotFoundError: No module named 'requests'" }), 'python-module');
check('NBSP в коде', idOf({ exit_code: 1, stderr: 'SyntaxError: invalid non-printable character U+00A0' }), 'python-syntax-nbsp');
check('SyntaxError', idOf({ exit_code: 1, stderr: 'SyntaxError: unexpected EOF while parsing' }), 'python-syntax');
check('Traceback', idOf({ exit_code: 1, stderr: 'Traceback (most recent call last):\n  File "x.py", line 9\nValueError: bad' }), 'python-traceback');

console.log('\nNode и среда:');
check('модуль не найден', idOf({ exit_code: 1, stderr: "Error: Cannot find module 'C:\\p\\missing.js'" }), 'node-module');
check('node не установлен', idOf({ exit_code: 127, stderr: 'node: command not found' }), 'node-command');
check('порт занят', idOf({ exit_code: 1, stderr: 'OSError: [WinError 10048] Only one usage of each socket address' }), 'port-busy');
check('кодировка', idOf({ exit_code: 1, stderr: "UnicodeDecodeError: 'utf-8' codec can't decode byte 0x8f" }), 'encoding');
check('сеть', idOf({ exit_code: 6, stderr: 'Could not resolve host: example.invalid' }), 'network');
check('молчаливый провал на Windows',
  idOf({ exit_code: 1, stdout: '', stderr: '', platform: 'windows' }), 'silent-fail-windows');

console.log('\nотказы до запуска (не путать с ошибкой команды):');
check('whitelist', idOf({ blocked: true, error: 'whitelist: command not in whitelist' }), 'blocked');
check('неверная рабочая папка', idOf({ error: 'cwd not found: C:\\nope' }), 'bad-cwd');
check('нет интерпретатора', idOf({ error: 'interpreter not found: node' }), 'no-interpreter');

console.log('\nзапасной вариант:');
check('неизвестный код возврата', idOf({ exit_code: 3, stdout: 'x', stderr: 'что-то странное' }), 'exit-code');

console.log('\nструктура ответа:');
const sample = describeFailure({ exit_code: 1, stderr: "'gti' is not recognized as an internal or external command" });
check('есть id', typeof sample.id, 'string');
check('есть заголовок', typeof sample.title, 'string');
check('есть подсказка', typeof sample.hint, 'string');
check('подсказка непустая', sample.hint.length > 20, true);
check('нет падения на мусоре', describeFailure(null) === null || typeof describeFailure(null) === 'object', true);
check('нет падения на строке', describeFailure('ошибка') === null || typeof describeFailure('ошибка') === 'object', true);

console.log('\n======================================================');
console.log('Итог: ' + passed + ' ok, ' + failed + ' fail');
if (failed) {
  console.log('Провалы: ' + fails.join(', '));
  process.exit(1);
}
console.log('Все проверки прошли.');
