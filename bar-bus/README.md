# Telegram-бот и Mini App для автобусного парка

Проект содержит Telegram-бот, Telegram Mini App, админ-панель и SQLite-базу для расписаний, обращений, новостей, рекламы, услуг, контактов и разнарядки водителей.

Передаточный VPS-архив называется `bar-bus`, но видимое название приложения не меняется.

## Быстрый старт

Нужен Node.js 24 или новее.

```bash
cp .env.example .env
npm start
```

Локальные адреса по умолчанию:

- Mini App: <http://localhost:3000>
- Админ-панель: <http://localhost:3000/admin>
- Проверка здоровья: <http://localhost:3000/api/health>

Для локального просмотра без Telegram polling:

```bash
npm run dev:local
```

## Основные команды

```bash
npm start
npm run verify
npm run test:smoke
npm run test:load
npm run import:routes -- /path/to/xml city
```

Типы импорта расписаний:

- `city` - городские маршруты;
- `suburban` - пригородные маршруты;
- `intercity` - междугородние маршруты.

## Настройка Telegram

Создайте бота через `@BotFather`, затем заполните `.env`:

```bash
WEBAPP_URL=https://your-domain.example
BOT_TOKEN=123456:telegram-token
BOT_USERNAME=your_bot_username
ADMIN_IDS=123456789,987654321
ADMIN_CHAT_ID=-1001234567890
ADMIN_KEY=long-random-admin-key
FILE_ACCESS_SECRET=another-long-random-secret
REQUIRE_TELEGRAM_AUTH=true
DISABLE_TELEGRAM_POLLING=false
```

## Документация

- [docs/HANDOVER_RU.md](docs/HANDOVER_RU.md) — передача продукта: возможности, роли, эксплуатация, состав поставки, безопасность.
- [docs/VPS_DEPLOY_RU.md](docs/VPS_DEPLOY_RU.md) — полная установка на удалённый сервер: сборка передаточного архива, Nginx, HTTPS, systemd, BotFather, backup, обновление, troubleshooting.
- [.env.example](.env.example) — все переменные окружения с прод-значениями и пояснениями.

Сборка передаточного архива (на машине разработчика, из папки с `.git`):

```bash
git archive --format=zip --prefix=bar-bus/ -o bar-bus-vps-$(date +%Y%m%d).zip HEAD
```

`git archive` включает только версионируемые файлы и автоматически исключает секреты, базу и приватные вложения (по `.gitignore`).

## Безопасность

Не передавайте публично:

- настоящий `.env`;
- `BOT_TOKEN`, `ADMIN_KEY`, `FILE_ACCESS_SECRET`;
- рабочую базу с реальными обращениями и подписчиками;
- приватные вложения из `data/uploads`;
- логи и временные файлы.

Для передачи проекта используйте подготовленный VPS-архив, где база очищена от персональных данных, а секреты заменяются уже на сервере.
