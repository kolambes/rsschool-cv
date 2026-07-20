# Design-System аудит · TG mini-app «Автобусный парк Барановичи»

Аудит проведён по методике `ui-ux-pro-max:design-system`: трёхслойные токены (primitive → semantic → component), спецификации компонентов с состояниями, шкалы интервалов/типографики. Цель — довести мини-приложение до современного, качественного, «дорогого» вида.

---

## 1. Итог одним абзацем

Визуально приложение уже подтянуто к премиум-референсу (тёплая палитра, Geist, градиентные герои, мягкие тени). **Но под капотом нет дизайн-системы** — есть три конкурирующих набора токенов, ~16 300 `!important`, семь render-blocking CSS-файлов на 1.76 МБ и никакого слоя примитивов. Из-за этого каждое изменение приходится «пробивать» специфичностью, компоненты расходятся между экранами, а темизация (в т.ч. тёмная тема) фактически мертва. Чтобы выглядеть «круто» стабильно, а не точечными заплатками, нужен один трёхслойный источник токенов и спецификации компонентов. Ниже — что именно и как.

---

## 2. Токен-архитектура: главная проблема

### Что сейчас (три параллельных namespace, все «семантические», без примитивов)

| Слой | Где | Пример | Проблема |
|------|-----|--------|----------|
| `--rs-*` | responsive-system.css | `--rs-accent`, `--rs-card`, `--rs-card-radius` | Реальный контроллер, но всё через `!important` |
| legacy `--*` | styles.css | `--bg #f3f0e8`, `--radius 18px`, `--accent` | Дублирует `--rs-*`, значения **расходятся** |
| `--app-theme-*` | theme-init.js (инлайн на `<html>`) | `--app-theme-bg` | Сильнее любого CSS, задаёт цвет из JS |

Три источника правды для одного и того же. Пример рассинхрона: `--radius` = **18px** (styles.css) против `--rs-card-radius` = **16px** (responsive-system) против **20px** (мой redesign). Радиус карточки зависит от того, какое правило победило в каскаде — отсюда «непричёсанность».

**Слоя примитивов нет вообще.** Цвета заданы сразу как семантические (`--accent: #0f766e`), поэтому нельзя переиспользовать оттенок, построить шкалу состояний (hover/active), сделать тему.

### Как надо (трёхслойно)

```
Primitive (сырые значения)  →  Semantic (назначение)  →  Component (под компонент)
--teal-600: #0f766e            --color-accent: teal-600   --btn-bg: color-accent
```

### Предлагаемый источник правды (один файл `tokens.css`, подключать первым)

```css
:root {
  /* ---------- PRIMITIVES ---------- */
  /* Neutral (тёплый песочный) */
  --sand-50:#fffdf7; --sand-100:#f7f3ea; --sand-200:#f0ebdf;
  --sand-300:#eae4d6; --sand-400:#ded6c4; --sand-500:#c2b9a4;
  --ink-900:#1c2a28; --ink-700:#3a4744; --ink-500:#6f6a5e;
  /* Brand teal */
  --teal-50:#e7f3f1; --teal-100:#c9e4df; --teal-500:#12897e;
  --teal-600:#0f766e; --teal-700:#0b5d57; --teal-800:#0a4e48;
  /* Status */
  --green-600:#16a34a; --amber-600:#b7791f; --orange-600:#c2410c;

  /* ---------- SEMANTIC ---------- */
  --color-bg:            var(--sand-200);
  --color-surface:       var(--sand-50);
  --color-surface-soft:  var(--sand-100);
  --color-text:          var(--ink-900);
  --color-text-muted:    var(--ink-500);   /* контраст ~5.3:1 — AA ✓ */
  --color-line:          var(--sand-300);
  --color-line-strong:   var(--sand-400);
  --color-accent:        var(--teal-600);
  --color-accent-hover:  var(--teal-700);
  --color-accent-soft:   var(--teal-50);
  --color-on-accent:     #ffffff;
  --color-success:var(--green-600); --color-warning:var(--amber-600); --color-danger:var(--orange-600);

  /* Elevation — двухслойная «мягкая» тень */
  --elev-1: 0 1px 2px rgba(40,30,15,.04), 0 8px 20px -14px rgba(40,30,15,.16);
  --elev-2: 0 1px 2px rgba(40,30,15,.04), 0 14px 32px -20px rgba(40,30,15,.22);
  --elev-3: 0 2px 4px rgba(40,30,15,.05), 0 24px 48px -28px rgba(40,30,15,.28);

  /* Radius scale */
  --radius-xs:8px; --radius-sm:12px; --radius-md:16px; --radius-lg:20px; --radius-pill:999px;

  /* Spacing scale (8px база + 4px полушаги) */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
  --space-5:20px; --space-6:24px; --space-8:32px; --space-10:40px;

  /* Type scale (1.25 — Major Third) */
  --font-ui:"Geist",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --font-mono:"Geist Mono",ui-monospace,SFMono-Regular,monospace;
  --text-xs:12px; --text-sm:13px; --text-base:15px; --text-lg:18px;
  --text-xl:22px; --text-2xl:27px; --text-3xl:33px;
  --leading-tight:1.15; --leading-normal:1.4; --leading-relaxed:1.55;
  --tracking-tight:-0.02em; --tracking-normal:-0.006em;

  /* Motion */
  --ease:cubic-bezier(.2,.7,.3,1); --dur-fast:120ms; --dur:160ms; --dur-slow:240ms;
}
```

Затем `--rs-*` и legacy `--*` **алиасить** на семантику (мостик, чтобы не переписывать 48 000 строк):

```css
:root, :root.is-comfort, body.is-comfort, body:not(.is-dark){
  --rs-bg:var(--color-bg); --rs-card:var(--color-surface); --rs-text:var(--color-text);
  --rs-muted:var(--color-text-muted); --rs-line:var(--color-line);
  --rs-accent:var(--color-accent); --rs-accent-strong:var(--color-accent-hover);
  --rs-card-radius:var(--radius-lg); --rs-control-radius:var(--radius-sm); --rs-shadow:var(--elev-2);
  --rs-font-family:var(--font-ui);
  /* legacy */
  --bg:var(--color-bg); --surface:var(--color-surface); --text:var(--color-text);
  --muted:var(--color-text-muted); --line:var(--color-line);
  --accent:var(--color-accent); --radius:var(--radius-md); --shadow:var(--elev-2);
}
```

Итог: **один источник правды**, темизация меняется в одном месте, шкалы консистентны.

---

## 3. Цвет и контраст (WCAG)

| Пара | Контраст | AA (4.5:1) |
|------|----------|-----------|
| text `#1c2a28` на surface `#fffdf7` | ~14.6:1 | ✓ AAA |
| muted `#6f6a5e` на surface | ~5.3:1 | ✓ |
| **исходный muted из макета `#8a8578`** | ~3.1:1 | ✗ — уже исправлено |
| **неактивная навигация `#a6a196`** | ~2.5:1 | ✗ — исправлено на `#7c776b` (~4.6:1) |
| **`--warning` как текст на белом** | ~3.9:1 | ✗ — использовать только как фон/иконку |

Рекомендация: закрепить в семантике `--color-text-muted: #6f6a5e` и никогда не опускать светлее; статусные цвета (`warning`/`danger`) — только заливка/иконка, не текст по белому.

---

## 4. Типографика

Сейчас три параллельные шкалы: `--rs-font-*` (28/24/20/16/14/12), legacy без явной шкалы, мои `clamp()` в теме. Разнобой весов: база местами `font-weight: 900/950` (очень жирно, «дёшево»), макет — 600.

**Рекомендация — одна модульная шкала (1.25)** из блока токенов выше: заголовки 600, тело 400/500, время — `Geist Mono` + `tnum`. Убрать веса ≥800 (кроме, возможно, крупного времени рейса). Заголовки — `--tracking-tight`, тело — `--tracking-normal`.

---

## 5. Интервалы, радиусы, тени (шкалы)

- **Spacing:** ввести 8px-сетку (`--space-*`). Сейчас паддинги «на глаз» (4/5/6/7/10/12/14/16/18/20px вперемешку). Единая шкала = ритм и «воздух», как в референсе.
- **Radius:** три конфликтующих значения (18/16/20) → одна шкала `xs 8 / sm 12 / md 16 / lg 20 / pill`. Карточки — `lg`, контролы/инпуты — `sm`, чипы — `pill`.
- **Elevation:** ввести 3 уровня (`--elev-1..3`, двухслойные). Уже частично сделано; закрепить как токены и применять по назначению (карточка — elev-2, hover — elev-3, вложенный блок — elev-1).

---

## 6. Спецификации компонентов (states & variants)

Главный пробел: **состояния определены непоследовательно** — focus почти везде отсутствовал (добавил `:focus-visible`), disabled/loading не описаны, hover есть не у всех. Ниже — целевые спеки под этот проект.

### Button (`.primary-button`, `.mini-button`, `.home-route-submit`)

| Состояние | Фон | Текст | Тень |
|-----------|-----|-------|------|
| default | `--color-accent` | `--color-on-accent` | elev-1 |
| hover | `--color-accent-hover` | on-accent | elev-2 |
| active | `--color-accent-hover` + `scale(.98)` | on-accent | none |
| focus-visible | + кольцо `accent/40%` offset 2px | | |
| disabled | `--sand-300` | `--ink-500` @ .6 | none |

Размеры: sm 36 / md 44 (тач-минимум) / lg 52. Радиус `--radius-sm`.

### Card (`.about-official-card`, `.service-card`, `.route-card`, `.home-services-card`)

| Вариант | Тень | Рамка | Радиус |
|---------|------|-------|--------|
| default | elev-2 | 1px `--color-line` | `--radius-lg` |
| interactive (hover) | elev-3 + `translateY(-2px)` | `accent/30%` | `--radius-lg` |
| nested | elev-1 | 1px line | `--radius-md` |

### Input / Search (`input`, `.search-box`, `.about-search`)

| Состояние | Рамка | Кольцо |
|-----------|-------|--------|
| default | 1px `--color-line` | — |
| hover | `--color-line-strong` | — |
| focus | `--color-accent` | `accent/16%` 3px |
| error | `--color-danger` | `danger/20%` |

Высота 44, радиус `--radius-sm`, паддинг `--space-3 --space-4`.

### Segmented (день: Сегодня/Будни/Выходные)

Трек `--color-surface-soft` + рамка; активный сегмент — **белая пилюля** `--color-surface` + elev-1, текст `--color-text`; неактивный — `--color-text-muted`. (Уже реализовано — закрепить как эталон.)

### Chip / Badge (время, статусы, «через N мин», LIVE, будильник)

| Вариант | Фон | Текст |
|---------|-----|-------|
| neutral | `--sand-100` | `--ink-700` |
| accent (выбран/ближайший) | `--color-accent` | on-accent |
| success («через N мин») | `green/12%` | `green-600` |
| warning («будильник») | `amber/14%` | `amber-600` |
| live | `accent/12%` + точка | accent |

Радиус `--radius-pill`, время — mono + `tnum`.

### Route badge (5A / 7)

Скруглённый квадрат 44×44, `--radius-sm`, номер — `Geist Mono` 600. **Цвет per-route оставить** (фирменная навигация по цвету), не заливать всё бирюзой.

### Bottom nav

Плашка `--color-surface` @ 92% + blur, активный пункт — `--color-accent` + подложка `accent/12%`, неактивный — `--color-text-muted` (AA). Размеры/позицию не трогать (адаптив).

### Timeline (схема маршрута)

Непрерывный вертикальный рельс `--color-line-strong`; точки — кольца; текущая остановка — карточка `accent/12%` + акцентная точка с halo; время — mono-пилюля. (Частично есть.)

---

## 7. `!important` и структура файлов (тех-долг, влияет на «качество»)

- **~16 300 `!important`** и **7 CSS-файлов** (1.76 МБ), правящих друг друга каскадом. Это прямая причина того, почему редизайн приходится «пробивать» и почему компоненты разъезжаются.
- **~2 629 вхождений `is-dark`** — мёртвый код (приложение light-only).
- **Герб 754 КБ** отрисовывается тяжёлым растром (сейчас скрыт по макету) — при возврате перекодировать в WebP (~60 КБ).

**Дорожная карта расчистки (без переписывания логики):**
1. Ввести `tokens.css` (раздел 2) первым файлом, `--rs-*`/legacy → алиасы.
2. Удалить `is-dark` dead-code → −25–35% CSS и минус тысячи `!important`.
3. Слить 7 файлов в 2 (`app.css` + `responsive.css`) через сборщик с минификацией и дедупом медиазапросов → ещё −40–60%.
4. По мере слияния заменять точечные заплатки на компонентные классы (`.btn`, `.card`, `.chip`) поверх токенов.

Потенциал: CSS с ~1.76 МБ до ~0.6–0.8 МБ, −690 КБ на гербе.

---

## 8. Приоритеты (эффект / усилие)

| # | Действие | Эффект | Усилие |
|---|----------|--------|--------|
| 1 | `tokens.css` (3 слоя) + алиасы `--rs-*`/legacy | Один источник правды, консистентность, живая темизация | Средн. |
| 2 | Закрепить типо-шкалу (1.25) и убрать веса ≥800 | «Дорогая» типографика | Низк. |
| 3 | 8px spacing + единый radius/elevation | Ритм и «воздух» как в референсе | Средн. |
| 4 | Спеки компонентов + состояния (focus/disabled) | Предсказуемый, доступный UI | Средн. |
| 5 | Удалить `is-dark` dead-code, слить/минифицировать CSS | −данные −память −`!important` | Средн. |
| 6 | Герб → WebP (при возврате) | −690 КБ | Низк. |

---

## 9. Что уже сделано в этой сессии (базис для системы)

Палитра/Geist/шапка по макету, крупные левые заголовки, пастельные плитки «О нас», карточки категорий, белая пилюля сегментов, двухслойные тени, `:focus-visible`, `prefers-reduced-motion`, доступный контраст muted/навигации, фикс налезания карточки «Расписание». Всё это — де-факто первый черновик component-слоя; раздел 2 превращает его в систему.
