/* Печатает текст промпта, который реально копируется в чат (AX_PROMPT).
 * Запуск: node show-prompt.js */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'prompt.js'), 'utf8');
const AX_PROMPT = eval(src.replace('const AX_PROMPT', 'var AX_PROMPT') + '\nAX_PROMPT');
console.log('символов: ' + AX_PROMPT.length);
const i = AX_PROMPT.indexOf('11. ПРОСМОТР');
console.log('--- пункт 11 ---');
console.log(AX_PROMPT.slice(i, AX_PROMPT.indexOf('Формат моего ответа')).trimEnd());
