# Security Remediation Report

Дата: 2026-06-18  
Проект: `bar-bus`  
Основание: `SECURITY_AUDIT_REPORT.md` и `SECURITY_FIX_PLAN.md`

## Scope

Исправлены подтвержденные уязвимости из прошлого security-аудита. В проверке участвовали read-only AI agents по двум зонам: auth/business logic и deployment/data exposure. После патча был запущен дополнительный read-only agent review; найденный им blocker по HTTP `ADMIN_KEY` persistence был исправлен и покрыт smoke-регрессией.

## Исправлено

### 1. `ADMIN_KEY` больше не создает постоянных админов

Что было: знание общего `ADMIN_KEY` позволяло создать постоянную Telegram/admin запись, которая переживала ротацию ключа.

Что изменено:

- Telegram bot onboarding теперь owner-gated: self-enroll разрешен только Telegram ID из `ADMIN_IDS`/`ADMIN_CHAT_ID` или уже активному полному admin.
- HTTP `POST /api/admin/admins` теперь требует сохраненный admin account через `requireStoredOwnerAdmin`.
- Временный principal от `x-admin-key` больше не может создавать или обновлять постоянные staff/admin записи.
- `POST/DELETE /api/admin/roster/drivers` теперь требуют сохраненный admin/dispatcher account через `requireStoredAdmin`, потому что этот путь создает persistent `driver` staff rows.
- Smoke-тест проверяет exploit path: `x-admin-key` на `POST /api/admin/admins` получает `403`, а Telegram ID не появляется в таблице `admins`.
- Smoke-тест также проверяет, что `x-admin-key` не может создать persistent driver row через roster API.

Остаточный риск: `ADMIN_KEY` остается мощным временным bearer-ключом для части admin API до ротации. Если он мог утечь, его нужно заменить.

### 2. Client-supplied `assignedRole` больше не влияет на обращения

Что было: публичный клиент мог передать `assignedRole` и направить обращение не тому отделу.

Что изменено:

- `createAppeal` всегда вычисляет `assignedRole` из серверной категории через `resolveAppealAssignedRole`.
- Видимость обращений теперь тоже вычисляется из категории, а не из сохраненного `assigned_role`.
- Старые потенциально tampered rows больше не влияют на role visibility.
- Smoke-тест проверяет `assignedRole: "driver"` для категории complaint и ожидает server-derived `moderator`.

### 3. Приватные appeal uploads вынесены из public tree

Что было: чувствительные вложения обращений сохранялись в `public/uploads/appeals`.

Что изменено:

- Новые appeal attachments пишутся в `PRIVATE_UPLOAD_DIR`, по умолчанию `data/uploads/appeals`.
- `PRIVATE_UPLOAD_DIR` можно вынести за пределы checkout через env.
- Direct static `/uploads/appeals/<file>` остается закрыт.
- Signed route `/api/files/appeals/<file>?expires=...&sig=...` продолжает работать.
- Добавлен legacy lookup для старых файлов, чтобы не сломать существующие обращения во время миграции.
- Smoke-тест проверяет direct 403, signed 200, tampered signature 403, expired signature 403.

### 4. Public stats больше не раскрывают служебные данные

Что было: `/api/bootstrap` и `/api/health` отдавали raw `getStats()` с appeals/subscribers/latestImport.

Что изменено:

- Добавлен `getPublicStats()` только с `routes`, `stops`, `departures`.
- Public bootstrap/health используют только public-safe DTO.
- Admin bootstrap продолжает получать operational stats.
- Smoke-тест рекурсивно проверяет отсутствие `appeals`, `subscribers`, `subscribersToday`, `latestImport`, `source`, `source_dir` в public stats.

### 5. Proxy trust стал явным

Что было: `TRUST_PROXY=true` доверял первому `X-Forwarded-For`.

Что изменено:

- `X-Forwarded-For` используется только если `TRUST_PROXY=true` и socket IP входит в `TRUSTED_PROXY_IPS`.
- `.env.example` теперь по умолчанию ставит `TRUST_PROXY=false`.
- Добавлен пример `TRUSTED_PROXY_IPS`.
- В `.env.example` указано, что edge proxy должен перезаписывать inbound `X-Forwarded-For`.

### 6. Telegram auth теперь fail-closed

Что было: `REQUIRE_TELEGRAM_AUTH=true` не защищал appeals, если `BOT_TOKEN` пустой.

Что изменено:

- `requireVerifiedTelegramUser` возвращает config failure, если auth обязателен, но `BOT_TOKEN` отсутствует.
- Production startup падает с явной ошибкой при `REQUIRE_TELEGRAM_AUTH=true` и пустом `BOT_TOKEN`.
- Smoke-тест запускает отдельный Node process и проверяет fail-closed config path.

### 7. Admin news permission восстановлен

Что было: endpoints требовали `news`, но ни одна роль не имела permission.

Что изменено:

- `PERMISSIONS.admin` получил `news`.
- Smoke-тест проверяет, что admin может читать `/api/admin/news`, а dispatcher получает `403`.

### 8. Repo/artifact hygiene усилен

Что изменено:

- `.gitignore` расширен для `.env.*`, root DB files, browser validation DBs, `data/uploads/`, `outputs/`, `tmp-*`, screenshots/json temp files и legacy `public/uploads/appeals/`.
- `.env.example` обновлен для private uploads и secure proxy defaults.

Важно: ignore rules не удаляют уже существующие локальные файлы и не защищают уже опубликованные архивы/бэкапы.

## Измененные файлы

- `server.js`
- `db.js`
- `scripts/smoke-test.js`
- `.gitignore`
- `.env.example`
- `SECURITY_REMEDIATION_REPORT.md`

## Проверки

Выполнено успешно:

- `node --check server.js`
- `node --check db.js`
- `node --check scripts/smoke-test.js`
- `npm run verify`
- `npm run test:smoke`
- `npm run test:load`
- `npm run test:roster`
- `npm run test:ux`

Ключевые regression proofs:

- `ADMIN_KEY` через HTTP больше не создает persistent admin row.
- `ADMIN_KEY` через roster driver API больше не создает persistent driver/staff row.
- Public appeal `assignedRole` override игнорируется.
- Старые stored `assigned_role` не управляют role visibility.
- Direct private attachment URL закрыт, signed URL работает, tampered/expired signatures запрещены.
- Public bootstrap/health не раскрывают служебные stats/import metadata.
- Production Telegram auth misconfig падает fail-closed.

## Операционные действия, которые код не может сделать безопасно сам

1. Если папка проекта, архивы или бэкапы могли быть кому-то переданы, нужно ротировать `BOT_TOKEN`, `ADMIN_KEY`, `YANDEX_MAPS_API_KEY` и любые другие реальные секреты.
2. Вынести `.env` из source tree или заменить его secret manager / server environment.
3. Перенести существующие legacy files из `public/uploads/appeals/` в private storage или удалить их после проверки, что они больше не нужны.
4. Убрать из repo tree локальные runtime artifacts: root `*.db*`, `tmp-*`, browser profiles, `outputs/`.
5. В production задать `PRIVATE_UPLOAD_DIR` за пределами source checkout.
6. Если используется reverse proxy, указать реальные `TRUSTED_PROXY_IPS` и на edge proxy перезаписывать inbound `X-Forwarded-For`.

## Proof Gaps

- `git` недоступен в окружении, поэтому tracked/untracked статус файлов не проверен.
- Существующие `.env`, DB, `outputs/`, browser profiles и legacy appeal uploads намеренно не удалялись, чтобы не потерять рабочие данные. Исправлено предотвращение новых попаданий и закрыты runtime paths; cleanup остается ручным операционным шагом.
