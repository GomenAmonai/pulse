# Pulse

[![Backend](https://github.com/GomenAmonai/pulse/actions/workflows/backend.yml/badge.svg)](https://github.com/GomenAmonai/pulse/actions/workflows/backend.yml)
[![Frontend](https://github.com/GomenAmonai/pulse/actions/workflows/frontend.yml/badge.svg)](https://github.com/GomenAmonai/pulse/actions/workflows/frontend.yml)
![Python 3.14](https://img.shields.io/badge/Python-3.14-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.143-009688?logo=fastapi&logoColor=white)
![SQLAlchemy 2 async](https://img.shields.io/badge/SQLAlchemy-2_async-D71F00?logo=sqlalchemy&logoColor=white)
![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-4169E1?logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-7-DC382D?logo=redis&logoColor=white)
![React 19](https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white)

Мониторинг доступности с публичной статус-страницей, в духе status.vercel.com. Пользователь
добавляет HTTP-мониторы (URL, интервал, ожидаемый статус, таймаут). Отдельный async-воркер
проверяет их по расписанию, хранит время ответа, открывает и закрывает инциденты с защитой от
флаппинга, шлёт уведомления в Telegram и на вебхуки, а дашборд обновляется в реальном времени.

**[▶ Live demo](https://gomenamonai.github.io/pulse/)**: работает без бэкенда, API и воркер
эмулируются прямо в браузере по тому же контракту (URL, коды ответов и ошибок, правила
инцидентов). Статус-страница: [/status/acme](https://gomenamonai.github.io/pulse/#/status/acme).
Дашборд: [/login](https://gomenamonai.github.io/pulse/#/login), вход демо-аккаунтом в один клик.
Через ~25 секунд после открытия у монитора «Payments webhook» начинается сценарный сбой: видно,
как после третьей неудачной проверки открывается инцидент, а после двух успешных закрывается.
Кнопка «Simulate outage» на странице монитора делает то же самое вручную. Полный стек
поднимается через `docker compose up` ([Запуск](#запуск)).

### На что посмотреть

- **Планировщик без дублей.** Воркер забирает просроченные мониторы одним запросом
  `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`: несколько реплик
  воркера никогда не проверят один монитор дважды, а следующая проверка назначается до начала
  запроса, так что медленный сайт не копит очередь. Тест держит блокировку в одной транзакции
  и проверяет, что вторая её обходит ([runner.py](backend/app/worker/runner.py),
  [тест](backend/tests/test_worker.py)).
- **asyncio + httpx под семафором.** Проверки идут конкурентно, но не больше
  `WORKER_CONCURRENCY` одновременно. У каждой проверки общий дедлайн (`asyncio.timeout`) поверх
  фазовых таймаутов httpx, тело ответа не скачивается (streaming, читаются только заголовки).
  Воркер корректно останавливается по SIGTERM и дожидается проверок в полёте.
- **Защита от флаппинга.** Чистая state machine без I/O: инцидент открывается после N неудач
  подряд (по умолчанию 3) и закрывается после M успехов (по умолчанию 2), пороги задаются на
  монитор. Начало инцидента — первая неудача серии, а не момент срабатывания порога. Частичный
  уникальный индекс гарантирует не больше одного открытого инцидента на монитор на уровне БД
  ([flapping.py](backend/app/services/flapping.py)).
- **Статистика в SQL, без циклов в Python.** Uptime и средняя/p95 задержка за 24h / 7d / 30d
  одним запросом через `FILTER` и `percentile_cont`, часовые спарклайны через `date_trunc`,
  бакеты графика через `date_bin`, 90 дневных столбиков через `generate_series`: пустой день
  приходит явной «серой» строкой, а простой инцидента через полночь делится между сутками.
  Каждая функция принимает пачку мониторов, так что дашборд на 25 мониторов стоит один
  запрос на виджет. Тесты сверяют результат с вычислением на Python
  ([stats.py](backend/app/services/stats.py), [тест](backend/tests/test_stats.py)).
- **Защита от SSRF.** Монитор заставляет сервер ходить по чужому URL, поэтому хост
  резолвится и все адреса должны быть публичными: `localhost`, приватные сети и
  `169.254.169.254` отклоняются при сохранении и перед каждым запросом. Редиректы воркер
  проходит сам, проверяя каждый шаг: иначе публичный URL мог бы сделать 302 на metadata.
- **Живые обновления по SSE.** Воркер публикует каждую проверку и смену инцидента в Redis
  pub/sub, API отдаёт их в `/api/stream`. Дашборд читает поток через `fetch`, а не
  `EventSource`, поэтому токен идёт в заголовке, а не в URL. Есть keep-alive и переподключение
  с backoff. Соединение с БД берётся только на время авторизации, а не на всё время стрима.
- **Уведомления.** Telegram и вебхуки, подписанные как у Stripe:
  `X-Pulse-Signature: t=<unix>,v1=<HMAC-SHA256>` от `timestamp.body`, что защищает и от подделки,
  и от replay. Повторы с экспоненциальной задержкой только на сетевые ошибки и 5xx.
- **JWT и rate limiting.** Access/refresh-токены разных типов (refresh нельзя использовать
  вместо access), Argon2id вне event loop, одинаковое время ответа для существующего и
  несуществующего email. Лимиты по IP — фиксированное окно в Redis (`INCR` + `EXPIRE` в одном
  pipeline) с fallback в память; на логин, регистрацию и публичную статус-страницу.
- **Чужое — это 404.** Мониторы, каналы и статус-страницы других пользователей отвечают 404,
  а не 403, чтобы нельзя было перебирать id.
- **100 тестов на реальном PostgreSQL, покрытие 97 %.** pytest + httpx `AsyncClient`, схема
  собирается настоящими миграциями Alembic, HTTP мокается через `httpx.MockTransport`, DNS
  подменяется, Redis-пути проверяются на fakeredis. В CI: ruff, `alembic check` (модели не
  разошлись с миграциями), тесты с порогом покрытия и сборка Docker-образа.

**Стек:** Python 3.14 · FastAPI · SQLAlchemy 2.0 async (asyncpg) · Alembic · Pydantic v2 ·
PostgreSQL 17 · Redis · httpx · PyJWT + Argon2 · pytest + pytest-asyncio · ruff · Docker
Compose · GitHub Actions. Фронтенд: React 19 + TypeScript · Vite · TanStack Query · Motion ·
Tailwind CSS 4 · Geist.

## Фронтенд

Чёрно-белый интерфейс в стиле Vercel, цвет только там, где он что-то значит: зелёный — up,
жёлтый — деградация, красный — down. Светлая и тёмная тема по системной настройке или вручную,
моноширинные цифры, 90-дневные полосы uptime и спарклайны задержки.

- **Публичная статус-страница** (`/#/status/acme`): общий статус, компоненты с 90 дневными
  столбиками (тултип с uptime, числом проверок и простоем за день) и история инцидентов за 14 дней.
- **Дашборд** (`/#/dashboard`): список мониторов со статусом, спарклайном за 24 часа, p95 и
  uptime; точка статуса «бьётся» на каждой пришедшей проверке. На странице монитора KPI за
  24h/7d/30d, график ответа (среднее, p95 и отметки неудачных проверок) с переключателем
  диапазона, полосы uptime, лента проверок в реальном времени и инциденты. Счётчик флаппинга
  показывает прогресс серии: «2 из 3 неудач подряд, на 3-й откроется инцидент».
- **Шторка создания монитора** выезжает справа и уходит туда же. Её можно тянуть: на
  отпускании решает не позиция, а спроецированная по скорости точка остановки, и пружина
  стартует со скоростью пальца. Ошибки валидации приходят из API и показываются у полей.
- **Демо-режим.** Без `VITE_API_URL` все запросы обслуживает
  [движок в браузере](frontend/src/demo/engine.ts): те же URL, ответы и коды ошибок, порт
  state machine флаппинга на TypeScript с тестами, зеркалящими Python-тесты. История за 90 дней
  процедурная — чистая функция от (монитор, время), поэтому одинакова при перезагрузке и в
  любом диапазоне графика; после загрузки страницы проверки идут «по-настоящему» в
  симулированном воркере и приходят тем же потоком событий, что и `/api/stream`.
- Учтены `prefers-reduced-motion` и `prefers-reduced-transparency`, отклик на pointer-down,
  поля 16px+, чтобы iOS не зумил страницу, тема применяется до первой отрисовки, hash-роутинг
  для GitHub Pages. Дашборд вынесен в отдельный чанк.

## Архитектура

```mermaid
flowchart LR
    ui["Дашборд и статус-страница<br/>(SPA на GitHub Pages)"] -->|REST + JWT| api["FastAPI<br/>uvicorn"]
    api -->|SSE /api/stream| ui
    api --> pg[("PostgreSQL<br/>мониторы, проверки, инциденты")]
    api <-->|rate limit, pub/sub| redis[("Redis")]
    worker["Async-воркер<br/>asyncio + httpx + семафор"] -->|FOR UPDATE SKIP LOCKED| pg
    worker -->|события| redis
    worker -->|HTTP-проверки| sites(("Сайты<br/>пользователей"))
    worker -->|инциденты| notify["Telegram<br/>подписанные вебхуки"]
```

```
backend/
├── app/
│   ├── api/            роуты: auth, monitors, pages (статус-страницы), channels, stream (SSE)
│   ├── services/       stats.py (SQL-агрегаты), flapping.py (state machine)
│   ├── worker/         runner.py (планировщик, запись результатов), checker.py (одна проверка)
│   ├── models.py       SQLAlchemy 2.0, типизированные Mapped[...]
│   ├── schemas.py      Pydantic v2
│   ├── notifier.py     Telegram, HMAC-вебхуки, ретраи
│   ├── targets.py      защита от SSRF
│   ├── events.py       Redis pub/sub → SSE, in-memory fallback
│   ├── ratelimit.py    фиксированное окно в Redis
│   └── seed.py         демо-аккаунт и 90 дней истории
├── migrations/         Alembic (async)
└── tests/
```

Бизнес-правила живут вне роутов: состояние монитора меняет чистая функция `step()`, агрегаты
считает `services/stats.py`, а API и воркер их только вызывают. Доменные исключения
(`BlockedTarget`, `MonitorLimit`, `SlugTaken`, …) один обработчик превращает в `404` / `409` /
`422` / `429` с машинно-читаемым `code`.

## API

Полная схема в Swagger UI: `/api/docs`.

| Метод | Путь | Кто | Что делает |
|---|---|---|---|
| `POST` | `/api/auth/register`, `/api/auth/login`, `/api/auth/refresh` | все | регистрация, JWT |
| `GET` | `/api/monitors` | владелец | мониторы со статистикой 24h/7d/30d и спарклайном |
| `POST` / `PATCH` / `DELETE` | `/api/monitors/{id}` | владелец | CRUD монитора |
| `POST` | `/api/monitors/{id}/pause`, `/resume` | владелец | пауза закрывает открытый инцидент |
| `GET` | `/api/monitors/{id}/latency?range=24h\|7d\|30d` | владелец | бакеты: среднее, p50, p95, неудачи |
| `GET` | `/api/monitors/{id}/uptime?days=90` | владелец | дневные столбики |
| `GET` | `/api/monitors/{id}/checks?before=&failed=` | владелец | проверки, keyset-пагинация |
| `GET` | `/api/incidents?state=open\|resolved` | владелец | инциденты по всем мониторам |
| `CRUD` | `/api/status-pages`, `/api/channels` | владелец | статус-страницы, каналы уведомлений |
| `POST` | `/api/channels/{id}/test` | владелец | отправить тестовое уведомление |
| `GET` | `/api/stream` | владелец | SSE: `check`, `incident.opened`, `incident.resolved` |
| `GET` | `/api/status/{slug}` | все | публичная статус-страница, `Cache-Control: max-age=15` |

```http
POST /api/monitors
{"name": "Admin", "url": "http://169.254.169.254/latest/meta-data/"}

422 Unprocessable Entity
{"code": "blocked_target", "detail": "169.254.169.254 resolves to a non-public address"}
```

```text
GET /api/stream
event: check
data: {"monitor_id": 5, "status": "up", "check": {"ok": false, "status_code": 503, "latency_ms": 212, …}}

event: incident.opened
data: {"id": 41, "monitor_id": 5, "monitor_name": "Payments", "started_at": "…", "cause": "Expected HTTP 200, got 503"}
```

## Запуск

### Docker Compose

```bash
docker compose up --build
```

Поднимаются PostgreSQL, Redis, API (миграции, демо-данные, uvicorn) и воркер. API на
http://localhost:8000/api/docs, статус-страница: `GET /api/status/acme`.
Демо-аккаунт: `demo@pulse.dev` / `pulse-demo-2026`. Один из демо-мониторов всегда отвечает 503,
поэтому через три проверки (около трёх минут) появляется инцидент.

### Без Docker

Нужны PostgreSQL 14+ (для `date_bin`) и, по желанию, Redis.

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate   # Linux/macOS: source .venv/bin/activate
pip install -r requirements-dev.txt
# переменные окружения: см. .env.example (минимум DATABASE_URL)
alembic upgrade head
python -m app.seed                 # демо-аккаунт и история
uvicorn app.main:app --reload      # API
python -m app.worker               # воркер, в соседнем терминале
```

Без `REDIS_URL` лимиты и события работают в памяти процесса: этого хватает для тестов, но
события воркера до дашборда без Redis не доходят. Для проверки сервисов на `localhost`
включите `ALLOW_PRIVATE_TARGETS=1` (только для разработки).

### Фронтенд

```bash
cd frontend
npm install
npm run dev                                    # демо-режим, без бэкенда
VITE_API_URL=http://localhost:8000 npm run dev # против локального API
```

Для боевого API задайте `CORS_ORIGINS` с адресом фронтенда.

### Тесты

```bash
cd backend
DATABASE_URL=postgresql+asyncpg://pulse:pulse@localhost:5432/pulse_test pytest --cov
ruff check . && ruff format --check .
cd ../frontend && npm run typecheck && npm test
```

Тестовая база пересоздаётся миграциями при каждом запуске.
