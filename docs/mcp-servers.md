# Каталог MCP-серверов

Поддержка добавлена в **v2.10.5**: кроме `stdio` теперь понимается **Streamable HTTP**,
без которого половина популярных серверов просто не запускается.

> **В конфиг эти серверы не добавлены.** `server/mcp_servers.json` остаётся пустым
> и выключенным: сервер не должен при первом же запуске поднимать чужие процессы и
> ходить в интернет без спроса. Ниже — готовые записи, которые ты **сам** вставляешь
> в свой конфиг и включаешь, когда нужно.

---

## Транспорты

| Поле | Что означает |
|---|---|
| `command` + `args` | локальный процесс, JSON-RPC через stdin/stdout (`stdio`) |
| `type: "http"` + `url` | удалённый сервер через Streamable HTTP |
| `headers` | заголовки для HTTP (например `Authorization`) |
| `env` | переменные окружения для процесса (`stdio`) |
| `cwd` | рабочая папка процесса (`stdio`) |
| `timeout` | таймаут одного вызова, сек |
| `enabled` | `true` / `false`. Всё выключено по умолчанию |

`type` можно не указывать: если есть `url`, транспорт определится сам.

Технические заголовки `Content-Type`, `Accept`, `Host` из `headers` перезаписать
нельзя — это сломало бы сам обмен. Токен в `Authorization` — можно.

### Что работает, а что нет

- ✅ `stdio` — как раньше
- ✅ Streamable HTTP: ответы и обычным JSON, и потоком SSE; сессия `Mcp-Session-Id`
  запоминается и возвращается автоматически
- ❌ **OAuth-логин не реализован.** Zapier, Notion, Atlassian требуют браузерного
  OAuth — через него не пройти. Работают только те, кому хватает статического
  токена в заголовке. На 401/403 расширение прямо скажет, что нужен токен.
- ❌ Устаревший «голый» SSE-эндпоинт (`GET` + события) не поддерживается. Atlassian
  отдаёт именно его — нужен `mcp-remote` как посредник (см. ниже).

---

## 💻 1. Кодинг и работа с файлами

**Filesystem** — читать и править файлы в папках, которые ты укажешь.
```json
{ "name": "filesystem", "enabled": false,
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me\\projects"] }
```

**Sequential Thinking** — пошаговое размышление над архитектурными задачами.
```json
{ "name": "thinking", "enabled": false,
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"] }
```

**GitHub** — ветки, issues, история, PR. Нужен токен с правами на репозиторий.
```json
{ "name": "github", "enabled": false,
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "github_pat_..." } }
```

**GitLab** — аналогично, `npx -y @modelcontextprotocol/server-gitlab`,
переменная `GITLAB_PERSONAL_ACCESS_TOKEN`.

> Токены живут в `mcp_servers.json` обычным текстом. Это конфиг на твоём диске —
> как `.env`. Главное — не класть его в git.

---

## 🔍 2. Веб-поиск и документация

**DuckDuckGo** — бесплатный поиск без API-ключа.
```json
{ "name": "duckduckgo", "enabled": false,
  "command": "uvx", "args": ["duckduckgo-mcp-server"] }
```

**Brave Search** — качественнее, но нужен ключ с [brave.com](https://brave.com/search/api/).
```json
{ "name": "brave", "enabled": false,
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-brave-search"],

---

## 🧠 3. Долговременная память проекта

**Memory Bank** — иерархическая база знаний о проекте (соглашения, структура, баги).
```json
{ "name": "memory-bank", "enabled": false,
  "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory-bank"] }
```

**Knowledge Graph Memory** — граф сущностей и связей между ними.
```json
{ "name": "kg-memory", "enabled": false,
  "command": "uvx", "args": ["mcp-server-knowledge-graph-memory"],
  "env": { "MEMORY_FILE_PATH": "C:\\Users\\me\\memory.json" } }
```

---

## 🌐 4. Браузер и тестирование

**Playwright** — открыть локальный проект, прокликать форму, сделать скриншот.
```json
{ "name": "playwright", "enabled": false,
  "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
```

**Puppeteer** — аналогично: `npx -y @modelcontextprotocol/server-puppeteer`.

**Chrome DevTools** — подключается к **уже запущенному** Chrome, где ты залогинен.
Нужен видимый Chrome с удалённой отладкой: `chrome.exe --remote-debugging-port=9222`.
```json
{ "name": "chrome", "enabled": false,
  "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] }
```

> Скриншоты он возвращает как `view`-блок — расширение покажет превью и
> прикрепит картинку к чату.

---

## 💼 5. Интеграции

**Notion** — удалённый сервер. **Нужен OAuth**, поэтому напрямую не заработает.
Вариант с готовым токеном:
```json
{ "name": "notion", "enabled": false,
  "type": "http", "url": "https://mcp.notion.com/mcp",
  "headers": { "Authorization": "Bearer ntn_..." } }
```

**Jira / Atlassian** — штатный эндпоинт отдаёт устаревший SSE, он не поддерживается.
Обходной путь — `mcp-remote`:
```json
{ "name": "atlassian", "enabled": false,
  "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.atlassian.com/v1/sse"] }
```

**Zapier** — 9000+ приложений. Тоже OAuth; без токена напрямую не включить:
```json
{ "name": "zapier", "enabled": false,
  "type": "http", "url": "https://mcp.zapier.com/api/mcp",
  "headers": { "Authorization": "Bearer ..." } }
```

---

## Как включить

1. Впиши нужные записи в `server/mcp_servers.json` (файл лежит рядом с `server.py`).
2. Поставь `"enabled": true` только тем, чем реально пользуешься.
3. Перезапусти `server.py` с флагом `--mcp` — или нажми **«Перечитать конфиг»**
   в разделе «Экспериментальное» настроек.
4. Нажми **«Проверить серверы»** — появятся найденные инструменты.
5. Нажми **«Скопировать список для ИИ»** и вставь отчёт в чат: без него модель не
   знает точных имён инструментов, выдумывает их, и вызов падает.

---

## Отладка

В консоли `server.py` каждый сервер логирует причину отказа. В браузере: `__axDiag()`.

| Симптом | Причина |
|---|---|
| `npx: не найдена` | не установлен Node.js |
| `HTTP 401` / `403` | нужен статический токен; OAuth не поддержан |
| `HTTP 404` | устаревший SSE-эндпоинт — берите `mcp-remote` |
| `не удалось соединиться` | нет доступа в интернет или сервер лежит |
| инструментов 0, ошибок нет | сервер запустился, но не отдал `tools/list` |
  "env": { "BRAVE_API_KEY": "BSA..." } }
```

**Context7** — свежая документация по библиотекам прямо во время кодинга.
Удалённый сервер, ничего ставить не нужно. Работает без ключа.
```json
{ "name": "context7", "enabled": false,
  "type": "http", "url": "https://mcp.context7.com/mcp" }
```

**Firecrawl** — превращает страницу в чистый Markdown. Ключ с [firecrawl.dev](https://firecrawl.dev).
```json
{ "name": "firecrawl", "enabled": false,
  "command": "npx", "args": ["-y", "firecrawl-mcp"], "env": { "FIRECRAWL_API_KEY": "fc-..." } }
```