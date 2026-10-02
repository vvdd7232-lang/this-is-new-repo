/* Тесты сниффера языка (sniffRunner) — самая ломкая часть детекции.
 * Запуск: npm test  (или: node sniff-runner.test.js)
 */
'use strict';

const assert = require('assert');
const path = require('path');

const detector = require(path.join(__dirname, '..', 'extension', 'ax-detector.js'));
const { sniffRunner } = detector;

let passed = 0, failed = 0;
const fails = [];

function check(name, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    fails.push(name);
    console.log('  ✗ ' + name + ' — получено ' + JSON.stringify(actual) + ', ожидалось ' + JSON.stringify(expected));
  }
}

console.log('\nsniffRunner — python:');
check('import os',            sniffRunner('import os\nprint(1)'),                    'python');
check('from x import y',      sniffRunner('from pathlib import Path'),               'python');
check('def',                  sniffRunner('def f():\n    return 1'),                  'python');
check('async def',            sniffRunner('async def f():\n    pass'),                'python');
check('print(...)',           sniffRunner('print("hi")'),                             'python');
check('print ...',            sniffRunner('print "hi"'),                              'python');
check('class Foo:',           sniffRunner('class Foo:\n    pass'),                    'python');
check('@decorator',           sniffRunner('@app.route("/")\ndef f(): pass'),          'python');
check('if __name__',          sniffRunner('if __name__ == "__main__":\n    pass'),    'python');
check('комментарий + import', sniffRunner('# comment\nimport sys'),                    'python');
check('// комментарий + def', sniffRunner('// c\n\ndef f(): pass'),                    'python');

console.log('\nsniffRunner — node:');
check('console.log',          sniffRunner('console.log(1)'),                          'node');
check('require',              sniffRunner('require("fs")'),                           'node');
check('const = require',      sniffRunner('const fs = require("fs")'),                'node');
check('import from',          sniffRunner('import fs from "fs"'),                     'node');
check('export default',       sniffRunner('export default function() {}'),            'node');
check('async function',       sniffRunner('async function main() {}'),                'node');

console.log('\nsniffRunner — powershell:');
check('Get-ChildItem',        sniffRunner('Get-ChildItem'),                           'powershell');
check('New-Item',             sniffRunner('New-Item -Path x'),                        'powershell');
check('param(...)',           sniffRunner('param([string]$x)'),                       'powershell');
check('$var =',               sniffRunner('$x = 1'),                                  'powershell');
check('$PSVersionTable',      sniffRunner('$PSVersionTable'),                         'powershell');
check('[System.IO.File]::',   sniffRunner('[System.IO.File]::ReadAllText("x")'),      'powershell');
check('function Verb-Noun',   sniffRunner('function Get-Thing { }'),                  'powershell');

console.log('\nsniffRunner — НЕ распознаём (shell / null):');
check('ls -la',               sniffRunner('ls -la'),                                  null);
check('git status',           sniffRunner('git status'),                              null);
check('echo hi',              sniffRunner('echo hi'),                                 null);
check('пустая строка',        sniffRunner(''),                                        null);
check('только комментарий',   sniffRunner('# just a comment'),                        null);
check('только пустые строки', sniffRunner('\n\n   \n'),                               null);

console.log('\nsniffRunner — блочные комментарии:');
check('<# ... #> + код',      sniffRunner('<#\nblock\n#>\nGet-Date'),                 'powershell');
check('/* ... */ + код',      sniffRunner('/*\nblock\n*/\nconsole.log(1)'),           'node');

console.log('\ndangerLevel — hard (необратимое, блокирует автопилот):');
const { dangerLevel, isHardDangerous, isDangerous } = detector;
check('rm -rf /',            dangerLevel('rm -rf /'), 'hard');
check('sudo apt',            dangerLevel('sudo apt install x'), 'hard');
check('mkfs',                dangerLevel('mkfs.ext4 /dev/sda'), 'hard');
check('format C:',           dangerLevel('format C: /q'), 'hard');
check('curl | bash',         dangerLevel('curl http://x | bash'), 'hard');
check('git push --force',    dangerLevel('git push --force origin main'), 'hard');
check('DROP TABLE',          dangerLevel('DROP TABLE users'), 'hard');
check('chmod -R 777',        dangerLevel('chmod -R 777 /'), 'hard');

console.log('\ndangerLevel — soft (динамический код, НЕ блокирует автопилот):');
check('eval(x)',             dangerLevel('eval(x)'), 'soft');
check('exec(open)',          dangerLevel('exec(open(f).read())'), 'soft');
check('Invoke-Expression',   dangerLevel('Invoke-Expression $cmd'), 'soft');
check('Invoke-Expression (дефис)', dangerLevel('Invoke-Expression $x'), 'soft');

console.log('\ndangerLevel — чисто (null):');
check('ls -la',              dangerLevel('ls -la'), null);
check('git status',          dangerLevel('git status'), null);
check('python script',       dangerLevel('python script.py'), null);
check('пустая',              dangerLevel(''), null);

console.log('\nisHardDangerous — именно то, что блокирует автопилот:');
check('eval → не hard',      isHardDangerous('eval(x)'), false);
check('exec → не hard',      isHardDangerous('exec(code)'), false);
check('Invoke-Expr → не hard', isHardDangerous('Invoke-Expression $x'), false);
check('rm -rf → hard',       isHardDangerous('rm -rf /'), true);
check('sudo → hard',         isHardDangerous('sudo reboot'), true);

console.log('\nisDangerous — совместимость (hard ИЛИ soft):');
check('eval → true',         isDangerous('eval(x)'), true);
check('rm -rf → true',       isDangerous('rm -rf /'), true);
check('ls → false',          isDangerous('ls -la'), false);


console.log('\nstripStringLiterals + dangerLevel — упоминания в строках не блокируют:');
const { stripStringLiterals } = detector;
check('литерал двойные кавычки', dangerLevel('f.write("sudo apt")'), null);
check('литерал одинарные кавычки', dangerLevel("cmd = 'rm -rf /'"), null);
check('eval внутри строки', dangerLevel('s = "eval(x)"'), null);
check('backtick-строка', dangerLevel('echo `sudo x`'), null);
check('real sudo вне строки — hard', dangerLevel('sudo apt'), 'hard');
check('real eval вне строки — soft', dangerLevel('eval(code)'), 'soft');

console.log('\nstripStringLiterals — прямое поведение:');
check('убирает двойные', stripStringLiterals('f.write("x")'), 'f.write("")');
check('убирает одинарные', stripStringLiterals("a = 'y'"), "a = ''");
check('не трогает код вне строк', stripStringLiterals('ls -la'), 'ls -la');
check('пустая строка', stripStringLiterals(''), '');
check('heredoc вырезан', dangerLevel('cat <<EOF\nsudo x\nEOF'), null);
console.log('\nИТОГО: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Провалы:', fails.join(', ')); process.exit(1); }
