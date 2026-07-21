# Полная инструкция по установке проекта на VPS

Документ подготовлен для проекта автобусного парка: Telegram-бот, Telegram Mini App, админ-панель и SQLite-база расписаний.

Цель: взять передаточный архив, загрузить его на VPS, настроить домен, HTTPS, Telegram-бота, автозапуск, резервные копии и ежедневную работу с приложением.

## 1. Что лежит в передаточном архиве

Архив для VPS должен содержать папку `bar-bus` со следующими важными файлами:

- `server.js` - HTTP-сервер, Telegram polling, API и раздача Mini App.
- `db.js` - SQLite-схема и функции работы с базой.
- `route-importer.js` - импорт XML-расписаний.
- `duty-roster.js` - разнарядка водителей.
- `package.json` и `package-lock.json` - команды запуска проекта.
- `.env.example` - пример переменных окружения.
- `public/` - интерфейс Mini App, админ-панель, иконки и публичные изображения.
- `scripts/` - проверки, импорт и локальные вспомогательные команды.
- `data/app.db` - подготовленная база для старта на сервере, если она включена в архив.
- `docs/VPS_DEPLOY_RU.md` и PDF-инструкция - этот документ.

В безопасный архив не должны попадать:

- настоящий `.env` с токенами и ключами;
- логи `*.log`;
- временные папки `tmp-*`;
- приватные вложения обращений;
- рабочая база с реальными обращениями, подписчиками, сотрудниками и статистикой, если архив передается не внутри доверенного контура.

## 1.1 Как собрать передаточный архив из репозитория

Архив собирается **на машине разработчика** (там, где лежит репозиторий с
папкой `.git`). Самый безопасный способ — `git archive`: он берёт только
файлы под контролем версий и автоматически исключает всё, что перечислено в
`.gitignore` — то есть настоящий `.env`, базу `*.db`, приватные вложения
`data/uploads` и `public/uploads/appeals`, `node_modules`, логи и `tmp-*`.

```bash
cd /path/to/bar-bus            # папка с .git
git archive --format=zip --prefix=bar-bus/ -o bar-bus-vps-$(date +%Y%m%d).zip HEAD
```

В архив попадут: `server.js`, `db.js`, все `*.js`, `public/` (интерфейс,
самохостинг-шрифты `public/fonts/*.woff2`, сжатый герб `*.webp`, иконки),
`scripts/`, `docs/`, `package.json`, `package-lock.json` и `.env.example`.
Секретов и персональных данных в нём нет по построению.

Проверьте состав перед отправкой:

```bash
unzip -l bar-bus-vps-*.zip | grep -E '\.env$|\.db|uploads/' || echo "OK: секретов и БД в архиве нет"
```

Если нужна **стартовая база** с уже загруженным расписанием (без персональных
данных), подготовьте её отдельно и положите в архив вручную как
`data/app.db` — но только если в ней нет реальных обращений, подписчиков и
сотрудников. По умолчанию приложение создаёт пустую базу при первом запуске.

## 2. Что понадобится до начала

Подготовьте заранее:

- VPS с Ubuntu 22.04/24.04 или близким Debian-based Linux;
- SSH-доступ к серверу;
- домен или поддомен, например `bus.example.com`;
- DNS A-запись домена на IP-адрес VPS;
- Telegram-бот, созданный через `@BotFather`;
- Telegram ID администраторов;
- архив проекта `bar-bus-vps-YYYYMMDD.zip`.

Проекту нужен Node.js 24 или новее. Это важно: приложение использует встроенный модуль `node:sqlite`, которого нет в старых версиях Node.js.

## 3. Схема работы на сервере

Рекомендуемая production-схема:

```text
Пользователь Telegram / браузер
        |
        | HTTPS
        v
Nginx на VPS
        |
        | http://127.0.0.1:3000
        v
Node.js приложение bar-bus
        |
        v
SQLite data/app.db
```

Telegram-бот работает через long polling внутри Node.js-процесса. Webhook отдельно настраивать не нужно. Важно, чтобы одновременно был запущен только один экземпляр бота с этим `BOT_TOKEN`.

## 4. Подготовка VPS

Зайдите на сервер по SSH:

```bash
ssh root@SERVER_IP
```

Обновите систему:

```bash
apt update
apt upgrade -y
```

Создайте отдельного пользователя для приложения:

```bash
adduser --disabled-password --gecos "" appbot
```

Установите базовые пакеты:

```bash
apt install -y curl unzip nginx ca-certificates ufw
```

Настройте firewall:

```bash
ufw allow OpenSSH
ufw allow "Nginx Full"
ufw --force enable
ufw status
```

## 5. Установка Node.js 24+

Проверьте текущую версию:

```bash
node -v
```

Если команда не найдена или версия ниже `v24`, установите Node.js 24. Один из обычных вариантов для Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
```

Проверьте результат:

```bash
node -v
npm -v
```

Ожидаемо: `node -v` показывает `v24.x.x` или новее.

Если при запуске приложения будет ошибка вида `No such built-in module: node:sqlite`, значит на сервере стоит слишком старая Node.js.

## 6. Загрузка архива на сервер

С локального компьютера загрузите архив на VPS:

```bash
scp bar-bus-vps-YYYYMMDD.zip root@SERVER_IP:/tmp/
```

На сервере распакуйте архив в `/opt`:

```bash
cd /opt
unzip -q /tmp/bar-bus-vps-YYYYMMDD.zip
chown -R appbot:appbot /opt/bar-bus
```

Проверьте структуру:

```bash
ls -la /opt/bar-bus
```

В папке должны быть `server.js`, `db.js`, `package.json`, `public`, `scripts`, `data` и `docs`.

## 7. Настройка `.env`

Перейдите в папку проекта:

```bash
cd /opt/bar-bus
```

Создайте рабочий `.env` из примера:

```bash
cp .env.example .env
chown appbot:appbot .env
chmod 600 .env
```

Сгенерируйте секреты:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Откройте `.env`:

```bash
nano .env
```

Пример production-настроек:

```bash
PORT=3000
NODE_ENV=production
CITY_NAME=Барановичи
WEBAPP_URL=https://bus.example.com

BOT_TOKEN=123456:telegram-token-from-botfather
BOT_USERNAME=your_bot_username

ADMIN_KEY=long-random-admin-key-from-openssl
FILE_ACCESS_SECRET=another-long-random-secret-from-openssl
PRIVATE_UPLOAD_DIR=./data/uploads

ADMIN_IDS=123456789,987654321
ADMIN_CHAT_ID=-1001234567890
REQUIRE_TELEGRAM_AUTH=true

TRUST_PROXY=true
TRUSTED_PROXY_IPS=127.0.0.1,::1
DISABLE_TELEGRAM_POLLING=false

YANDEX_MAPS_API_KEY=
```

Главные переменные:

- `PORT` - локальный порт Node.js. Обычно `3000`.
- `NODE_ENV=production` - production-режим.
- `WEBAPP_URL` - публичный HTTPS-адрес Mini App без слеша в конце.
- `BOT_TOKEN` - токен от `@BotFather`.
- `BOT_USERNAME` - username бота без `@`. Не обязателен, но полезен для ссылок.
- `ADMIN_KEY` - длинный секрет для входа в админ-панель. Не используйте короткие слова.
- `FILE_ACCESS_SECRET` - отдельный секрет для подписанных приватных ссылок на файлы.
- `PRIVATE_UPLOAD_DIR=./data/uploads` - папка приватных вложений обращений.
- `ADMIN_IDS` - Telegram ID администраторов через запятую.
- `ADMIN_CHAT_ID` - ID чата или группы для служебных уведомлений, если используется.
- `REQUIRE_TELEGRAM_AUTH=true` - обращения из Mini App требуют проверенную Telegram-сессию.
- `TRUST_PROXY=true` - включается, когда приложение закрыто за Nginx на этом же сервере.
- `TRUSTED_PROXY_IPS=127.0.0.1,::1` - доверяем только локальному Nginx.
- `DISABLE_TELEGRAM_POLLING=false` - включает Telegram-бота.
- `YANDEX_MAPS_API_KEY` - необязательный ключ Яндекс.Карт.

Важно: настоящий `.env` не отправляйте в чат, не кладите в публичный архив и не коммитьте.

## 8. Первый ручной запуск

Перед systemd полезно один раз запустить приложение руками:

```bash
cd /opt/bar-bus
sudo -u appbot node --no-warnings server.js
```

Если все хорошо, в консоли появится сообщение о запуске HTTP-сервера и Telegram polling. Остановите ручной запуск клавишами `Ctrl+C`.

Проверьте health endpoint:

```bash
curl http://127.0.0.1:3000/api/health
```

Если порт в `.env` другой, замените `3000` на свой порт.

## 9. Автозапуск через systemd

Создайте service-файл:

```bash
nano /etc/systemd/system/bar-bus.service
```

Вставьте:

```ini
[Unit]
Description=Bar-Bus Telegram Mini App
After=network.target

[Service]
Type=simple
User=appbot
Group=appbot
WorkingDirectory=/opt/bar-bus
EnvironmentFile=/opt/bar-bus/.env
ExecStart=/usr/bin/node --no-warnings server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/bar-bus/data /opt/bar-bus/public/uploads /opt/bar-bus/logs

[Install]
WantedBy=multi-user.target
```

Создайте нужные папки и права:

```bash
mkdir -p /opt/bar-bus/data/uploads /opt/bar-bus/public/uploads /opt/bar-bus/logs
chown -R appbot:appbot /opt/bar-bus/data /opt/bar-bus/public/uploads /opt/bar-bus/logs
```

Запустите сервис:

```bash
systemctl daemon-reload
systemctl enable bar-bus
systemctl start bar-bus
systemctl status bar-bus
```

Полезные команды:

```bash
systemctl restart bar-bus
systemctl stop bar-bus
systemctl start bar-bus
journalctl -u bar-bus -f
journalctl -u bar-bus --since "1 hour ago"
```

## 10. Настройка Nginx

Создайте конфиг:

```bash
nano /etc/nginx/sites-available/bar-bus
```

Вставьте, заменив домен:

```nginx
server {
    listen 80;
    server_name bus.example.com;

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
```

Включите сайт:

```bash
ln -s /etc/nginx/sites-available/bar-bus /etc/nginx/sites-enabled/bar-bus
nginx -t
systemctl reload nginx
```

Проверьте:

```bash
curl http://bus.example.com/api/health
```

На этом этапе домен еще может быть без HTTPS. Telegram Mini App требует HTTPS, поэтому следующий шаг обязателен.

## 11. HTTPS через Certbot

Установите Certbot:

```bash
apt install -y certbot python3-certbot-nginx
```

Получите сертификат:

```bash
certbot --nginx -d bus.example.com
```

Проверьте автообновление:

```bash
systemctl status certbot.timer
certbot renew --dry-run
```

Проверьте приложение:

```bash
curl https://bus.example.com/api/health
```

И откройте в браузере:

```text
https://bus.example.com
https://bus.example.com/admin
```

## 12. Настройка Telegram-бота

В `@BotFather`:

1. Создайте бота через `/newbot`, если бот еще не создан.
2. Скопируйте токен в `.env` как `BOT_TOKEN`.
3. Откройте `Bot Settings`.
4. Настройте `Menu Button` или Mini App URL на `https://bus.example.com`.
5. Убедитесь, что домен открывается по HTTPS без предупреждений браузера.

После перезапуска сервер сам вызывает Telegram API для настройки команд и кнопки меню. Поэтому обычно достаточно:

```bash
systemctl restart bar-bus
journalctl -u bar-bus -f
```

Если бот раньше работал через webhook, приложение при polling по умолчанию очищает webhook. Не запускайте второй экземпляр этого же бота на другом сервере или локальном компьютере: Telegram polling допускает только один активный процесс.

## 13. Первый вход администратора

Проверьте, что ваш Telegram ID указан в `.env`:

```bash
ADMIN_IDS=123456789
```

Перезапустите приложение:

```bash
systemctl restart bar-bus
```

Варианты входа:

- открыть `https://bus.example.com/admin` и ввести `ADMIN_KEY`;
- открыть бота в Telegram, написать `/admin`, затем следовать подсказкам;
- открыть Mini App из кнопки меню Telegram и перейти в админ-панель, если у аккаунта есть доступ.

Администраторы из `ADMIN_IDS` автоматически добавляются в базу с ролью `admin`.

Роли в админ-панели:

- `admin` - полный доступ;
- `appeals_manager` - обращения, жалобы, вопросы и предложения;
- `ads_manager` - рекламные заявки и реклама;
- `dispatcher` - расписание и разнарядка;
- `moderator` - обращения;
- `sto_manager` - обращения по СТО и услугам;
- `driver` - водительский доступ к разнарядке.

## 14. Проверки после установки

С сервера:

```bash
curl http://127.0.0.1:3000/api/health
curl https://bus.example.com/api/health
```

Из папки проекта:

```bash
cd /opt/bar-bus
npm run verify
```

Дополнительные проверки:

```bash
npm run test:smoke
npm run test:load
```

Если тесты запускают отдельный временный сервер, это нормально. Основной production-сервис продолжает работать через systemd.

## 15. Работа с расписанием

Расписание можно загрузить через админ-панель или CLI.

Через админ-панель:

1. Откройте `/admin`.
2. Перейдите в раздел расписания.
3. Загрузите XML-файлы.
4. Проверьте аудит, количество маршрутов, остановок и отправлений.

Через CLI:

```bash
cd /opt/bar-bus
sudo -u appbot npm run import:routes -- /path/to/city-xml city
sudo -u appbot npm run import:routes -- /path/to/suburban-xml suburban
sudo -u appbot npm run import:routes -- /path/to/intercity-xml intercity
```

Допустимые типы:

- `city` - городские маршруты;
- `suburban` - пригородные;
- `intercity` - междугородние.

Импорт очищает только таблицы расписания: маршруты, направления, остановки и отправления. Обращения, новости, реклама, сотрудники и подписчики не должны удаляться при штатном импорте.

## 16. Работа с обращениями

Пассажир может создать обращение:

- в Mini App;
- через команду `/appeal` в Telegram-боте;
- через чат с ботом, отправляя текст, фото или аудио.

Администратор или сотрудник:

- получает уведомление о новом обращении;
- открывает обращение в админ-панели;
- отвечает пассажиру;
- меняет статус;
- закрывает рабочий чат, когда вопрос решен.

Приватные вложения обращений хранятся в `data/uploads`. Не публикуйте эту папку напрямую через Nginx.

## 17. Работа с новостями, рекламой, услугами и руководством

Эти разделы управляются из админ-панели. Загруженные публичные изображения обычно лежат в `public/uploads`.

Для корректных прав после ручного копирования файлов:

```bash
chown -R appbot:appbot /opt/bar-bus/public/uploads
```

Если изображения не загружаются, проверьте:

- права на `public/uploads`;
- `client_max_body_size` в Nginx;
- логи `journalctl -u bar-bus -f`.

## 18. Разнарядка водителей

В админ-панели можно загрузить CSV разнарядки. Система проверяет табельные номера и может отправлять назначения водителям в Telegram.

Водителю нужен Telegram ID и табельный номер в базе. После привязки водитель может получать свои задания через бота.

Ежедневная отправка управляется переменными:

```bash
DUTY_ROSTER_DAILY_ENABLED=true
DUTY_ROSTER_DAILY_SEND_TIME=18:00
```

Если переменные не указаны, ежедневная отправка включена по умолчанию, время по умолчанию - `18:00`.

## 19. Резервные копии

Минимальный backup должен включать:

- `/opt/bar-bus/.env`;
- `/opt/bar-bus/data/app.db`;
- `/opt/bar-bus/data/uploads`;
- `/opt/bar-bus/public/uploads`.

Простой безопасный backup с остановкой сервиса:

```bash
systemctl stop bar-bus
tar -czf /root/bar-bus-backup-$(date +%F-%H%M).tar.gz \
  /opt/bar-bus/.env \
  /opt/bar-bus/data \
  /opt/bar-bus/public/uploads
systemctl start bar-bus
```

Проверьте, что архив создан:

```bash
ls -lh /root/bar-bus-backup-*.tar.gz
```

Для автоматического backup можно добавить cron-задачу, но сначала обязательно проверьте ручной сценарий восстановления.

## 20. Обновление проекта на сервере

Перед обновлением сделайте backup.

Остановите приложение:

```bash
systemctl stop bar-bus
```

Сохраните текущую папку:

```bash
cp -a /opt/bar-bus /opt/bar-bus.backup-$(date +%F-%H%M)
```

Распакуйте новый архив во временную папку:

```bash
mkdir -p /opt/bar-bus-new
unzip -q /tmp/bar-bus-vps-YYYYMMDD.zip -d /opt/bar-bus-new
```

Перенесите рабочие данные из старой установки:

```bash
cp /opt/bar-bus/.env /opt/bar-bus-new/bar-bus/.env
cp /opt/bar-bus/data/app.db /opt/bar-bus-new/bar-bus/data/app.db
cp -a /opt/bar-bus/data/uploads /opt/bar-bus-new/bar-bus/data/
cp -a /opt/bar-bus/public/uploads /opt/bar-bus-new/bar-bus/public/
```

Замените папки:

```bash
mv /opt/bar-bus /opt/bar-bus-old
mv /opt/bar-bus-new/bar-bus /opt/bar-bus
chown -R appbot:appbot /opt/bar-bus
systemctl start bar-bus
systemctl status bar-bus
```

Если что-то пошло не так, остановите сервис и верните `/opt/bar-bus-old`.

## 21. Как понять, что все работает

Проверьте по списку:

- `systemctl status bar-bus` показывает `active (running)`;
- `curl http://127.0.0.1:3000/api/health` отвечает без ошибки;
- `https://bus.example.com/api/health` отвечает через Nginx и HTTPS;
- `https://bus.example.com` открывает Mini App;
- `https://bus.example.com/admin` открывает админ-панель;
- Telegram-бот отвечает на `/start`;
- кнопка меню Telegram открывает Mini App;
- `/admin` в боте запускает вход администратора;
- в админ-панели видны маршруты и расписание;
- тестовое обращение создается и появляется в админке;
- ответ администратора приходит пассажиру в Telegram.

## 22. Частые проблемы

Проблема: `No such built-in module: node:sqlite`.

Решение: установите Node.js 24 или новее.

Проблема: сайт открывается, но Telegram Mini App не запускается.

Решение: проверьте HTTPS, `WEBAPP_URL`, BotFather Menu Button и отсутствие предупреждений сертификата.

Проблема: Nginx показывает `502 Bad Gateway`.

Решение:

```bash
systemctl status bar-bus
journalctl -u bar-bus -n 100
curl http://127.0.0.1:3000/api/health
```

Чаще всего причина - Node.js-приложение не запущено или слушает другой порт.

Проблема: бот не отвечает.

Решение: проверьте `BOT_TOKEN`, `DISABLE_TELEGRAM_POLLING=false`, логи systemd и убедитесь, что этот же бот не запущен на другом компьютере.

Проблема: ошибка `409 Conflict` от Telegram.

Решение: где-то работает второй polling-процесс или webhook. Остановите старый процесс, затем перезапустите сервис.

Проблема: вход в админку не работает.

Решение: проверьте `ADMIN_IDS`, `ADMIN_KEY`, перезапустите сервис и убедитесь, что Telegram ID указан без `@` и без пробелов.

Проблема: файлы обращений или изображения не загружаются.

Решение:

```bash
chown -R appbot:appbot /opt/bar-bus/data/uploads /opt/bar-bus/public/uploads
```

Также проверьте `client_max_body_size 50m` в Nginx.

Проблема: в production приложение падает с ошибкой про `REQUIRE_TELEGRAM_AUTH=true requires BOT_TOKEN`.

Решение: заполните `BOT_TOKEN` или временно выключите `REQUIRE_TELEGRAM_AUTH`, если запускаете только демонстрационный стенд без Telegram.

## 23. Правила безопасности

Обязательно:

- храните `.env` только на сервере;
- меняйте `BOT_TOKEN`, если архив или токен могли попасть третьим лицам;
- используйте длинные `ADMIN_KEY` и `FILE_ACCESS_SECRET`;
- не публикуйте `data/uploads`;
- делайте backup перед обновлениями;
- не запускайте один и тот же `BOT_TOKEN` на двух серверах одновременно;
- держите SSH и сервер обновленными;
- ограничьте доступ к VPS только ответственным администраторам.

Желательно:

- включить SSH-вход по ключу;
- отключить парольный SSH-вход для root после настройки;
- хранить backup вне VPS;
- периодически проверять `journalctl -u bar-bus`;
- ротировать секреты после передачи проекта другому подрядчику или администратору.

## 24. Короткая памятка команд

```bash
systemctl status bar-bus
systemctl restart bar-bus
journalctl -u bar-bus -f
nginx -t
systemctl reload nginx
curl http://127.0.0.1:3000/api/health
curl https://bus.example.com/api/health
cd /opt/bar-bus && npm run verify
```

## 25. Мини-чеклист перед сдачей

- Архив загружен и распакован в `/opt/bar-bus`.
- `.env` создан вручную на сервере и не лежит в публичном архиве.
- Node.js версии 24+.
- `systemd`-сервис включен и запущен.
- Nginx проксирует на `127.0.0.1:3000`.
- HTTPS-сертификат выпущен.
- `WEBAPP_URL` совпадает с HTTPS-доменом.
- BotFather Menu Button ведет на тот же домен.
- Telegram-бот отвечает на `/start`.
- Админ входит в `/admin`.
- Расписание открывается.
- Backup-процедура проверена хотя бы один раз.

