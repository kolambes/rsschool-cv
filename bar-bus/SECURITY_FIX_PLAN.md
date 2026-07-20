# Security Fix Plan

Дата: 2026-06-18  
Scope: fixes for findings in `SECURITY_AUDIT_REPORT.md`

Код приложения пока не изменялся. План ниже перечисляет минимальные изменения и проверки.

## P0 / Immediate Operational Actions

### Rotate Exposed-Capable Secrets

Trigger: `.env` with live secret-bearing values is inside the project tree.

Actions:

- Rotate `BOT_TOKEN` via BotFather if this tree may have been shared, archived, deployed as source, or backed up outside a trusted machine.
- Replace `ADMIN_KEY` with a new long random value.
- Rotate `YANDEX_MAPS_API_KEY` if exposure is possible.
- Remove secrets from source-tree copies and deployment bundles.
- Store runtime secrets in a secret manager, server environment, or path outside the repo.

Validation:

- Search deployment/archive outputs for `.env`, bot token patterns, and admin key names.
- Confirm production app still starts with secrets injected externally.

### Disable Persistent Admin Enrollment By Shared Key

Finding: shared `ADMIN_KEY` can permanently enroll any Telegram account as full admin.

Minimal code changes:

- Separate `ADMIN_KEY` API fallback from Telegram onboarding.
- Replace Telegram onboarding key with one-time invite tokens.
- Require existing owner/admin approval or `ADMIN_IDS` membership before creating a role `admin`.
- Default new Telegram staff enrollment to least privilege, never `admin`.
- Add audit log entry and owner notification on every enrollment.

Tests:

- Non-admin Telegram ID plus `ADMIN_KEY` must not create an active admin row.
- One-time invite can be used once, expires, and creates only the intended role.
- Rotating `ADMIN_KEY` does not affect existing valid admins, but leaked old key cannot onboard anyone.

## P1 / Application Logic Fixes

### Ignore Client-Supplied `assignedRole` On Public Appeals

Finding: public appeal creation trusts `assignedRole`.

Minimal code changes:

- In `createAppeal`, derive `assignedRole` from sanitized category for public/client creation.
- If admin reassignment is needed, add an authenticated admin-only reassignment endpoint with audit history.
- Consider validating category against a server-owned allowlist.

Suggested implementation shape:

```js
const category = sanitizeText(input.category || "Обращение", 64);
assignedRole: resolveAppealAssignedRole(category)
```

Tests:

- `POST /api/appeals` with `assignedRole: "driver"` stores the server-derived role, not `driver`.
- Notification recipients follow category-derived role.
- Admin appeal visibility cannot be changed by public request body.

### Move Private Appeal Uploads Outside `public/`

Finding: private appeal files depend on Node static deny rule while stored under `public/uploads/appeals`.

Actions:

- Introduce a private upload root, for example `data/uploads/appeals` or external object storage.
- Keep returned attachment URLs as signed `/api/files/appeals/<file>` only.
- Migrate existing private files or support legacy lookup during transition.
- Ensure nginx/CDN never serves the private upload root directly.

Tests:

- Direct `/uploads/appeals/<file>` returns 403/404.
- Signed `/api/files/appeals/<file>?expires=...&sig=...` works before expiry.
- Expired or modified signatures return 403.

## P1 / Repo And Artifact Hygiene

### Remove Runtime Artifacts From The Repo Tree

Findings: DB snapshots, browser profiles, roster reports, logs and temporary screenshots are under repo root.

Actions:

- Move or delete generated `tmp-*`, `tmp-cdp-*`, `tmp-chrome-profile*`, root `browser-validation-app.db*`, screenshots, and generated reports from the project tree.
- Keep validation/browser profiles in OS temp directories.
- Keep production SQLite and uploads outside source checkout where possible.

Recommended `.gitignore` additions:

```gitignore
*.db
*.db-*
*.db-shm
*.db-wal
outputs/
tmp-*/
tmp-*.png
tmp-*.json
browser-validation-*.db*
public/uploads/appeals/
```

Be careful before ignoring all `public/uploads/`: some public media may be intentional content. Split private uploads from public content first.

Validation:

- Build/deploy archive must not contain `.env`, `data/*.db*`, root `*.db*`, `outputs/`, `tmp-*`, browser profiles, private appeal uploads, or logs.
- A fresh clone plus documented setup should recreate only source-controlled assets.

## P2 / Deployment Hardening

### Redact Public Stats

Finding: `/api/bootstrap` and `/api/health` expose raw `getStats()`.

Actions:

- Create `getPublicStats()` with only intentionally public counters.
- Keep `latestImport`, appeal counts, subscriber counts, and import source paths admin-only.
- Consider making `/api/health` return `{ ok: true }` plus non-sensitive build/version data only.

Tests:

- Unauthenticated `/api/bootstrap` does not include `latestImport`, `subscribers`, or `appeals`.
- Admin summary still returns operational stats after authorization.

### Make Proxy Trust Explicit

Finding: `TRUST_PROXY=true` trusts first `X-Forwarded-For`.

Actions:

- Keep `TRUST_PROXY=false` unless Node is reachable only behind a trusted reverse proxy.
- At nginx/CDN, strip inbound `X-Forwarded-For` and set it from the actual client IP.
- Prefer an allowlist of trusted proxy IPs over a boolean.
- Bind Node to localhost/private interface in production.

Tests:

- Direct request with spoofed `X-Forwarded-For` cannot bypass rate limit.
- Behind real proxy, rate limit identity uses the actual client IP.

### Fail Closed When Telegram Auth Is Required

Finding: `REQUIRE_TELEGRAM_AUTH=true` still allows appeal creation when `BOT_TOKEN` is empty.

Actions:

- In production startup, reject `REQUIRE_TELEGRAM_AUTH=true` with missing `BOT_TOKEN`.
- In protected routes, remove `&& BOT_TOKEN` from the auth enforcement condition and return a config error when token is missing.

Tests:

- `REQUIRE_TELEGRAM_AUTH=true` and empty `BOT_TOKEN` returns 500/503 config error or startup failure.
- Invalid/missing `initData` returns 401 when Telegram auth is required.

## P3 / Functional Fix

### Fix Admin News Permission

Issue: admin news endpoints require `news`, but no role has that permission.

Options:

- Add `news` to `PERMISSIONS.admin`.
- Or change news endpoints to use an existing permission if news is intentionally managed by another role.
- Add frontend tab permission if news UI is re-enabled.

Tests:

- Admin can list/create/delete news.
- Non-news roles cannot manage news unless intended.

## Regression Test Checklist

- Security unit/integration test for public `assignedRole` override.
- Security test for Telegram admin enrollment using shared `ADMIN_KEY`.
- Static artifact check for forbidden deploy files.
- Private appeal file direct/static and signed-route tests.
- Public stats response snapshot test.
- Proxy header/rate-limit test.
- Telegram auth fail-closed config test.

