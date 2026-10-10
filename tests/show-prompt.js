/* Печатает текст промпта, который реально копируется в чат (AX_PROMPT),
 * а также вариант с разделом про автопилот.
 * Запуск: node show-prompt.js */
'use strict';
const { AX_PROMPT, AX_AUTOPILOT_SECTION, AX_buildPrompt } = require('../extension/prompt.js');
console.log('символов (базовый): ' + AX_PROMPT.length);
console.log('символов (с автопилотом): ' + AX_buildPrompt(true).length);
console.log('--- базовый промпт ---');
console.log(AX_PROMPT);
console.log('\n--- раздел про автопилот ---');
console.log(AX_AUTOPILOT_SECTION);
