/* Тесты detectRunner — распознавание execute-блоков на разных сайтах.
 * Каждая фикстура имитирует разметку конкретного чата (ChatGPT, Claude,
 * DeepSeek, Arena, generic). Запуск: node detect-runner.test.js
 */
'use strict';

const assert = require('assert');
const path = require('path');
const { JSDOM } = require('jsdom');

const detector = require(path.join(__dirname, '..', 'extension', 'ax-detector.js'));
const { detectRunner, getCodeText, detectFallback } = detector;

let passed = 0, failed = 0;
const fails = [];

function withDom(html, fn) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>');
  const prevDoc = global.document;
  const prevWin = global.window;
  global.document = dom.window.document;
  global.window = dom.window;
  try { return fn(dom.window.document); }
  finally { global.document = prevDoc; global.window = prevWin; }
}

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  try {
    assert.strictEqual(a, e);
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed++;
    fails.push(name);
    console.log('  ✗ ' + name + ' — получено ' + a + ', ожидалось ' + e);
  }
}

console.log('\ndetectRunner — класс language-* на <code>:');
withDom('<pre><code class="language-execute">ls -la</code></pre>', (doc) => {
  check('language-execute', detectRunner(doc.querySelector('pre')), { lang: 'execute', runner: 'shell' });
});
withDom('<pre><code class="language-execute-python">print(1)</code></pre>', (doc) => {
  check('language-execute-python', detectRunner(doc.querySelector('pre')), { lang: 'execute-python', runner: 'python' });
});
withDom('<pre><code class="language-execute-js">console.log(1)</code></pre>', (doc) => {
  check('language-execute-js', detectRunner(doc.querySelector('pre')), { lang: 'execute-js', runner: 'node' });
});
withDom('<pre><code class="language-execute-pwsh">Get-Date</code></pre>', (doc) => {
  check('language-execute-pwsh', detectRunner(doc.querySelector('pre')), { lang: 'execute-pwsh', runner: 'powershell' });
});

console.log('\ndetectRunner — класс lang-* на <pre>:');
withDom('<pre class="lang-execute"><code>echo hi</code></pre>', (doc) => {
  check('lang-execute', detectRunner(doc.querySelector('pre')), { lang: 'execute', runner: 'shell' });
});

console.log('\ndetectRunner — data-атрибуты:');
withDom('<pre data-language="execute"><code>dir</code></pre>', (doc) => {
  check('pre[data-language]', detectRunner(doc.querySelector('pre')), { lang: 'execute', runner: 'shell' });
});
withDom('<pre><code data-lang="execute">dir</code></pre>', (doc) => {
  check('code[data-lang]', detectRunner(doc.querySelector('pre')), { lang: 'execute', runner: 'shell' });
});

console.log('\ndetectRunner — маркер #!execute в первой строке:');
withDom('<pre><code>#!execute\necho hi</code></pre>', (doc) => {
  check('#!execute + shell', detectRunner(doc.querySelector('pre')), { lang: 'execute', runner: 'shell' });
});
withDom('<pre><code>#!execute-python\nprint(1)</code></pre>', (doc) => {
  check('#!execute-python', detectRunner(doc.querySelector('pre')), { lang: 'execute', runner: 'python' });
});
withDom('<pre><code>// execute-js\nconsole.log(1)</code></pre>', (doc) => {
  check('// execute-js', detectRunner(doc.querySelector('pre')), { lang: 'execute', runner: 'node' });
});

console.log('\ndetectRunner — маркер рядом (фоллбэк fuzzy):');
withDom('<div><span>Execute</span><pre><code>ls</code></pre></div>', (doc) => {
  const r = detectRunner(doc.querySelector('pre'));
  check('соседний span "Execute"', r && r.runner, 'shell');
});
withDom('<div><span>Execute • Copy</span><pre><code>print(1)</code></pre></div>', (doc) => {
  const r = detectRunner(doc.querySelector('pre'));
  check('"Execute • Copy" → shell (без python-подсказки)', r && r.runner, 'shell');
});
withDom('<div><span>Execute python</span><pre><code>print(1)</code></pre></div>', (doc) => {
  const r = detectRunner(doc.querySelector('pre'));
  check('"Execute python" → python', r && r.runner, 'python');
});

console.log('\ndetectRunner — НЕ распознаём:');
withDom('<pre><code class="language-python">print(1)</code></pre>', (doc) => {
  check('language-python (без execute)', detectRunner(doc.querySelector('pre')), null);
});
withDom('<pre><code class="language-bash">ls</code></pre>', (doc) => {
  check('language-bash', detectRunner(doc.querySelector('pre')), null);
});
withDom('<pre><code>просто текст</code></pre>', (doc) => {
  check('голый <pre> без метки', detectRunner(doc.querySelector('pre')), null);
});

console.log('\ngetCodeText — снятие маркера первой строки:');
withDom('<pre><code>#!execute\necho hi\necho bye</code></pre>', (doc) => {
  check('маркер снят', getCodeText(doc.querySelector('pre')), 'echo hi\necho bye');
});
withDom('<pre><code>echo hi\necho bye</code></pre>', (doc) => {
  check('без маркера — текст не тронут', getCodeText(doc.querySelector('pre')), 'echo hi\necho bye');
});
withDom('<pre><code>#!execute-python\nprint(1)</code></pre>', (doc) => {
  check('маркер с суффиксом снят', getCodeText(doc.querySelector('pre')), 'print(1)');
});

console.log('\ndetectFallback — текстовая метка рядом (weak/strong):');
withDom('<div><span>execute</span><pre><code>ls</code></pre></div>', (doc) => {
  const r = detectFallback(doc.querySelector('pre'), { defaultRunner: 'shell' });
  check('strong (одно слово)', r && r.strong, true);
});
withDom('<div><span>А теперь execute эту команду:</span><pre><code>ls</code></pre></div>', (doc) => {
  const r = detectFallback(doc.querySelector('pre'), { defaultRunner: 'shell' });
  check('weak (в предложении)', r && r.strong, false);
});
withDom('<div><p>Ничего похожего</p><pre><code>ls</code></pre></div>', (doc) => {
  const r = detectFallback(doc.querySelector('pre'), { defaultRunner: 'shell' });
  check('нет метки → null', r, null);
});

console.log('\nИТОГО: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('Провалы:', fails.join(', ')); process.exit(1); }
