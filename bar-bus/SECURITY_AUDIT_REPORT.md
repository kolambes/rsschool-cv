# Security Audit Report

Дата: 2026-06-18  
Проект: `bar-bus`  
Режим: repository-wide deep security review, read-only for application code

## Scope

Проверены backend/API, Telegram Mini App и bot flows, admin panel/RBAC, SQLite data layer, upload/static-file handling, XML/CSV imports, frontend DOM sinks, config/secrets, generated/runtime artifacts, dependencies and deployment-sensitive settings.

В проверке участвовали 6 read-only AI agents плюс ручная валидация кандидатов. Код приложения не изменялся. `git` в окружении недоступен, поэтому tracked/untracked статус файлов не доказан; все выводы по артефактам основаны на фактическом наличии файлов в рабочем дереве и `.gitignore`.

В отчете намеренно не приводятся значения секретов из `.env`.

## Executive Summary

| Severity | Count | Findings |
| --- | ---: | --- |
| High | 2 | постоянное Telegram-admin enrollment через общий `ADMIN_KEY`; реальные секреты в `.env` внутри дерева проекта |
| Medium | 4 | клиент управляет `assignedRole` обращения; runtime DB/browser artifacts под repo root; PII отчеты разнарядки в `outputs/`; private appeal uploads лежат под `public/` |
| Low | 3 | public stats/import metadata leak; `TRUST_PROXY` может ослаблять rate limit; `REQUIRE_TELEGRAM_AUTH` fails open без `BOT_TOKEN` |
| Logic | 1 | admin news API требует permission, которого нет в `PERMISSIONS` |

Главная реальная бизнес-логика: публичный `POST /api/appeals` доверяет `assignedRole` из тела запроса. Это было подтверждено отдельной временной SQLite-базой: `createAppeal({ assignedRole: "driver" ... })` сохраняет `assignedRole: "driver"`.

## Threat Model

Критичные активы:

- `BOT_TOKEN`, `ADMIN_KEY`, `ADMIN_IDS`, `ADMIN_CHAT_ID`, API keys.
- Telegram identity через `initData`.
- Admin roles and permissions.
- Appeals: messages, contacts, attachments, `clientToken`.
- SQLite application data, reminders, subscribers, admins, driver/roster data.
- Schedule/import integrity.
- Generated reports and browser/test artifacts.

Основные attacker sources:

- unauthenticated public web/API users;
- Telegram Mini App users with valid `initData`;
- external Telegram users interacting with the bot;
- low-privilege staff/admin roles;
- anyone who receives repo/archive/deployment/backup artifacts;
- clients spoofing proxy headers if Node is reachable directly or proxy headers are not sanitized.

## Findings

### 1. Shared `ADMIN_KEY` Can Permanently Enroll Any Telegram Account As Admin

| Field | Value |
| --- | --- |
| Severity | High |
| Confidence | High for code behavior; exploit requires key exposure |
| Category | Authentication / authorization design flaw |
| CWE | CWE-287 / CWE-306 / CWE-798-adjacent |
| Affected lines | `server.js:2176-2177`, `server.js:2216`, `server.js:2236-2244`, `server.js:2264-2279`, `db.js:3945-3984` |

#### Summary

The bot admin onboarding flow treats possession of the reusable `ADMIN_KEY` as enough to create or update a persistent active admin record with role `admin`. This means a leaked key is not just a bearer secret for current requests; it becomes a durable account-enrollment token. After enrollment, rotating `ADMIN_KEY` does not remove the attacker from `admins`.

#### Evidence

- `/admin` in bot starts a pending admin-key prompt: `sendAdminAccessPrompt` stores `pendingAdminAccess` at `server.js:2176-2177`.
- `handlePendingAdminAccess` compares the Telegram message text directly to `ADMIN_KEY` at `server.js:2216`.
- On success, it calls `saveAdmin({ telegramId: fromId, role: "admin", active: true })` at `server.js:2238-2244`.
- Future access is then resolved by Telegram ID via `getAdminByTelegramId` in `resolveAdmin` (`server.js:1017-1020`) and admin records are persisted by `saveAdmin` (`db.js:3945-3984`).

#### Impact

Anyone who learns the shared key can enroll their own Telegram account as full admin and keep access until the admin row is deleted or disabled. This compounds any `.env`, chat, screenshot, backup, log, or operator leakage of `ADMIN_KEY`.

#### Remediation

Use separate one-time invitation tokens for Telegram enrollment. Restrict first admin bootstrap to `ADMIN_IDS` or local setup only. Require existing owner approval for new admin accounts. Store role requested by onboarding as least-privilege by default, not `admin`. Log every enrollment and alert the owner.

### 2. Live Secrets Are Present In `.env` Inside The Project Tree

| Field | Value |
| --- | --- |
| Severity | High if repo/archive/deploy/backup is shared; Medium if strictly local and unshared |
| Confidence | High for local presence, unknown for external exposure |
| Category | Secret management |
| CWE | CWE-798 / CWE-200 |
| Affected lines | `.env:6`, `.env:11`, `.env:14`, `.env:17`, `.env:23`, `.gitignore:2`, `server.js:125`, `server.js:132`, `server.js:1907`, `server.js:2001` |

#### Summary

The working tree contains a real `.env` with secret-bearing runtime configuration. `.gitignore` ignores `.env`, but that does not protect source archives, deployment bundles, backups, copied folders, or accidental publication.

#### Evidence

- `.env` exists and contains set values for `BOT_TOKEN`, `ADMIN_IDS`, `ADMIN_CHAT_ID`, `ADMIN_KEY`, and `YANDEX_MAPS_API_KEY`.
- `server.js` uses `BOT_TOKEN` for Telegram API calls (`server.js:1907`) and Telegram file access (`server.js:2001`).
- `server.js` uses `ADMIN_KEY` for admin API auth (`server.js:1023-1037`) and bot enrollment (`server.js:2189-2244`).
- `.gitignore` includes `.env` at `.gitignore:2`, but the file is still physically inside the repo directory.

#### Impact

Exposure of this tree can give bot control and admin access. Combined with Finding 1, `ADMIN_KEY` exposure can become persistent Telegram-admin account creation.

#### Remediation

Move `.env` outside the source tree or provision secrets through the deployment secret manager. Ensure source archives and deploy bundles exclude it. Rotate `BOT_TOKEN`, `ADMIN_KEY`, and provider keys if this directory may have been shared.

### 3. Public Appeal Creation Trusts Client-Supplied `assignedRole`

| Field | Value |
| --- | --- |
| Severity | Medium |
| Confidence | High |
| Category | Business logic / authorization boundary |
| CWE | CWE-807 |
| Affected lines | `server.js:1253-1261`, `db.js:2728-2746`, `db.js:851-854`, `db.js:2819-2831`, `db.js:3019-3028`, `server.js:2614-2620` |

#### Summary

The public appeal endpoint passes request body data into `createAppeal`, and `createAppeal` stores `input.assignedRole` before falling back to server-side category routing. That stored value controls appeal visibility and Telegram staff notification routing.

#### Evidence

- Public `POST /api/appeals` calls `createAppeal(await prepareAppealPayload(await parseBody(...)), user)` at `server.js:1253-1261`.
- `createAppeal` sets `assignedRole` from `input.assignedRole || resolveAppealAssignedRole(...)` at `db.js:2744`.
- `roleCanSeeAppeal` trusts stored `assignedRole` for visibility at `db.js:851-854`.
- `notifyAdmins` sends the appeal to recipients returned for `appeal.assignedRole` at `server.js:2614-2620`.
- Static validation with a disposable DB confirmed that `createAppeal({ assignedRole: "driver" ... })` persists `assignedRole: "driver"`.

#### Impact

A public or Telegram-authenticated user can misroute appeal content, contact data, and attachments to an unintended staff role. This can hide an appeal from the intended queue, disclose it to the wrong department, and generate targeted staff notification spam. It does not directly grant admin API access.

#### Remediation

Ignore `assignedRole` on public/client appeal creation. Always derive the role server-side from category using `resolveAppealAssignedRole`. If admins need manual reassignment, implement a separate authenticated admin endpoint with audit logging.

### 4. Runtime Databases And Browser Profiles Are Stored Under The Repo Root

| Field | Value |
| --- | --- |
| Severity | Medium, High if shared externally |
| Confidence | High for local presence, unknown for external exposure |
| Category | Sensitive artifact exposure |
| CWE | CWE-200 |
| Affected paths | `browser-validation-app.db`, `browser-validation-app.db-shm`, `browser-validation-app.db-wal`, `data/app.db*`, `tmp-cdp-*`, `tmp-chrome-profile*`, `.gitignore:1-5` |

#### Summary

The repo root contains a validation SQLite database and many browser/CDP profile directories. The current `.gitignore` covers `data/*.db*`, but not root `*.db*`, `tmp-*`, browser profiles, or `outputs/`.

#### Evidence

- Root files exist: `browser-validation-app.db`, `browser-validation-app.db-shm`, `browser-validation-app.db-wal`.
- `tmp-cdp-profile-header-10011/Default` contains browser artifacts such as `History`, `Login Data`, `Local Storage`, `Session Storage`, and `Network/Cookies`.
- `.gitignore` only lists `node_modules/`, `.env`, `*.log`, `data/*.tmp`, `data/*.db`, `data/*.db-*`.

#### Impact

If the repo folder is zipped, uploaded, committed, or deployed, these artifacts can leak app state, admin/staff Telegram IDs, reminders, local storage/session state, cookies, history, and saved-login metadata.

#### Remediation

Delete runtime/test browser profiles from the project tree, add ignore rules for root `*.db*`, `tmp-*`, browser profiles, screenshots and generated reports, and keep disposable validation databases in OS temp directories.

### 5. Generated Roster Reports In `outputs/` Contain Driver PII And Are Not Ignored

| Field | Value |
| --- | --- |
| Severity | Medium |
| Confidence | High for local presence, unknown for external exposure |
| Category | Sensitive generated artifact exposure |
| CWE | CWE-200 |
| Affected paths | `outputs/roster-virtual-20260610/README.md:3`, `outputs/roster-virtual-20260610/summary.json:2`, `outputs/roster-virtual-20260610/delivery_report.csv`, `outputs/roster-virtual-20260610/deliveries.json`, `.gitignore:1-5` |

#### Summary

Generated roster reports are inside `outputs/`, and `.gitignore` does not exclude that directory. The report files include source workstation path, driver names, tab numbers, route/work assignments, vehicle identifiers, and delivery metadata.

#### Evidence

- `outputs/roster-virtual-20260610/README.md` records a local source CSV path.
- `summary.json` contains driver/assignment counts and duplicate recipient data.
- `delivery_report.csv`, `deliveries.json`, screenshots, and XLSX artifacts are present.

#### Impact

Sharing the repo or deployment bundle can disclose employee PII and operational dispatch details.

#### Remediation

Move generated reports outside the repo or into a private artifact store. Add `outputs/` to `.gitignore` if these are not source assets. Redact driver names, tab numbers, vehicle identifiers, and source paths in any report meant for sharing.

### 6. Private Appeal Uploads Are Stored Under The Public Static Tree

| Field | Value |
| --- | --- |
| Severity | Medium in deployments with direct static serving; Low in current Node-only path |
| Confidence | Medium |
| Category | Deployment-sensitive data exposure |
| CWE | CWE-200 |
| Affected lines | `server.js:115-120`, `server.js:785-821`, `server.js:835-857`, `server.js:1829-1834` |

#### Summary

Appeal attachments are sensitive, but `APPEAL_UPLOAD_DIR` is under `public/uploads/appeals`. The Node static handler denies direct `/uploads/appeals/` access and signed URLs are used for `/api/files/appeals/...`; this is good for the current handler, but fragile if nginx/CDN/static hosting serves `public/` directly.

#### Evidence

- `PUBLIC_DIR` is `public`, and `APPEAL_UPLOAD_DIR` is `public/uploads/appeals` (`server.js:115-120`).
- `saveAppealAttachment` writes files there and returns `/uploads/appeals/<file>` (`server.js:785-821`).
- Signed API serving exists (`server.js:835-857`).
- Direct static access is denied only inside `serveStatic` (`server.js:1829-1834`).

#### Impact

A future reverse-proxy/static-server config can bypass the Node deny rule and expose complaint images/audio.

#### Remediation

Move private appeal uploads outside `PUBLIC_DIR`. Keep public uploads (`ads`, `news`, `services`, `leadership`) separate from private uploads. Serve private files only through the signed API route.

### 7. Public Bootstrap/Health Expose Operational Stats And Import Metadata

| Field | Value |
| --- | --- |
| Severity | Low |
| Confidence | High |
| Category | Information disclosure |
| CWE | CWE-200 |
| Affected lines | `server.js:1123`, `server.js:1144-1149`, `db.js:2378-2397`, `scripts/import-routes.js:42-45` |

#### Summary

Public `/api/bootstrap` and `/api/health` return `getStats()`, which includes counts for appeals/subscribers and the raw latest import batch. CLI import stores `SOURCE_DIR` as `source`, so public responses may reveal local/operator paths when CLI imports are used.

#### Evidence

- `getPublicBootstrapData` includes `stats: getStats()` (`server.js:1123`).
- `/api/health` returns stats directly (`server.js:1144-1145`).
- `getStats()` returns `latestImport` from `import_batches` (`db.js:2385-2397`).
- CLI import passes `source: SOURCE_DIR` (`scripts/import-routes.js:42-45`).

#### Impact

Unauthenticated users can learn operational volume and, depending on import source, local filesystem/import metadata.

#### Remediation

Return a public-safe stats DTO. Keep `latestImport`, subscriber counts, appeal counts, and source paths admin-only.

### 8. `TRUST_PROXY=true` Can Make Rate Limits Trust Spoofed `X-Forwarded-For`

| Field | Value |
| --- | --- |
| Severity | Low to Medium depending on deployment topology |
| Confidence | Medium |
| Category | Rate-limit bypass / deployment config |
| CWE | CWE-807 |
| Affected lines | `.env.example:18`, `server.js:464-475`, `server.js:478-493` |

#### Summary

When `TRUST_PROXY=true`, `getRequestIp` uses the first `X-Forwarded-For` value directly. `.env.example` recommends `TRUST_PROXY=true`. If Node is reachable directly, or a proxy forwards client-supplied `X-Forwarded-For` without sanitizing, attackers can rotate the header to bypass rate limits.

#### Evidence

- `.env.example:18` sets `TRUST_PROXY=true`.
- `getRequestIp` reads the first `x-forwarded-for` value when trusted (`server.js:464-469`).
- Rate limit identity is based on `getRequestIp` plus user agent (`server.js:472-475`).

#### Impact

Brute-force/spam throttles for admin auth, appeals, news likes/views, reminders, XML import, and roster upload can be weakened in a misconfigured deployment.

#### Remediation

Bind Node to localhost/private network behind the proxy. Strip inbound `X-Forwarded-For` at the edge and set it yourself. Prefer an explicit trusted proxy list rather than a boolean. Keep `TRUST_PROXY=false` for local/direct deployments.

### 9. Telegram Auth Requirement Fails Open If `BOT_TOKEN` Is Empty

| Field | Value |
| --- | --- |
| Severity | Low |
| Confidence | High |
| Category | Fail-open authentication config |
| CWE | CWE-287 |
| Affected lines | `server.js:964-970`, `server.js:1244-1260` |

#### Summary

`getTelegramUser` returns null if `BOT_TOKEN` is empty. Public appeals enforce Telegram only when `REQUIRE_TELEGRAM_AUTH && BOT_TOKEN && !user?.isVerified`. Therefore `REQUIRE_TELEGRAM_AUTH=true` does not fail closed if `BOT_TOKEN` is missing.

#### Impact

Misconfigured production can unintentionally allow non-Telegram public appeal creation.

#### Remediation

If `REQUIRE_TELEGRAM_AUTH=true`, reject protected routes when `BOT_TOKEN` is missing. Treat missing token as startup/config failure in production.

## Additional Logic Issue

### Admin News Endpoints Require A Permission No Role Has

This is not a privilege escalation, but it blocks intended admin functionality.

- `PERMISSIONS` in `db.js:39-48` does not include `news` for any role.
- Admin news endpoints require `requireAdmin(req, url, "news")` at `server.js:1714-1733`.

Result: even `admin` lacks the required permission for admin news API calls.

## Reviewed Surfaces With No Reportable Finding

| Surface | Outcome | Evidence |
| --- | --- | --- |
| Telegram Mini App `initData` | No issue found | HMAC data-check string, timing-safe compare, auth-date TTL/skew at `server.js:982-1005` |
| Client appeal chat access | No IDOR found | Requires verified Telegram owner or `clientToken` at `server.js:1068-1075`; token is random at `db.js:2746` |
| Direct private upload browsing | Current Node path blocks it | `/uploads/appeals/` denied at `server.js:1829-1834`; signed API route at `server.js:835-857` |
| File upload path traversal | No issue found in reviewed path | Random filenames, magic checks, size caps, containment at `server.js:725-821` |
| SQL injection | No issue found in reviewed API paths | Main user-controlled DB access uses prepared statements; dynamic fragments observed are boolean/static |
| XML import XXE | No XXE candidate | Route XML is parsed with string extraction, not entity-expanding XML parser; endpoint is admin/dispatcher-gated |
| Frontend stored DOM XSS | No grounded finding | Most content uses `textContent`; rich text escapes via `escapeHtml` before markdown replacements at `public/app.js:5530-5566` |
| Telegram file SSRF | No issue found | Downloads are fixed to Telegram API/file hosts with encoded path segments at `server.js:2001-2008` |
| Dependencies | No dependency finding | `package.json`/lockfile contain no third-party runtime packages |

## Open Questions

- Are `.env`, `outputs/`, `tmp-*`, browser profiles, root DB files, or `public/uploads/appeals/` included in real deployment archives/backups?
- Is the production static layer serving `public/` directly, or does every request pass through `server.js`?
- Is Node reachable directly from the internet when `TRUST_PROXY=true`?
- Was the current `.env` ever shared, committed, copied into chat, or deployed as part of a source archive?
