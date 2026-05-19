# PupilLabsReplacer — Plan & TODO

Стек: **Tauri 2 + React 19 + TypeScript + Tailwind v4 + FastAPI + Python 3.12**

---

## Фазы разработки

### Фаза 0 — Окружение и конфиги ✅
- [x] Node.js 22, Rust 1.95, Python 3.12
- [x] `npm create tauri-app` — шаблон react-ts
- [x] Tailwind v4 через `@tailwindcss/vite`
- [x] Path alias `@/` → `src/`
- [x] Python venv + FastAPI + uvicorn + pandas + numpy
- [ ] Установить webkit2gtk (нужен sudo — сделать вручную)
- [ ] Проверить `npm run tauri dev` запускается

---

### Фаза 1 — Структура проекта и базовый layout
**Цель:** запускается окно с боковой навигацией, переключение между страницами

- [x] Создать структуру папок `src/`
  ```
  src/
  ├── components/
  │   ├── ui/          ← переиспользуемые кнопки, карточки и т.д.
  │   └── layout/      ← Sidebar, TopBar, MainLayout
  ├── pages/           ← Recordings, Projects, Player, Export
  ├── store/           ← Zustand глобальный стейт
  ├── lib/             ← api.ts (axios/fetch к FastAPI), utils.ts
  ├── hooks/           ← кастомные хуки
  └── types/           ← TypeScript интерфейсы
  ```
- [x] Создать `backend/` структуру
  ```
  backend/
  ├── app/
  │   ├── main.py         ← FastAPI app + CORS
  │   ├── api/routes/     ← recordings.py, projects.py, events.py, export.py
  │   ├── models/         ← Pydantic схемы
  │   ├── services/       ← бизнес-логика
  │   └── utils/          ← парсинг Pupil данных
  ├── venv/
  └── requirements.txt
  ```
- [x] FastAPI `main.py`: CORS, health-check `/api/health`
- [x] Sidebar с иконками: Recordings / Projects / Export
- [x] React Router или простой state-based роутинг
- [x] Tailwind тема: тёмная, акцентный цвет

---

### Фаза 2 — Recordings (импорт и просмотр записей)
**Цель:** выбрать папку с записями Pupil Labs Neon, видеть список с метаданными

**Формат данных Pupil Labs Neon (папка записи):**
```
recording_uuid/
├── info.json              ← метаданные (дата, длительность, устройство)
├── gaze.csv               ← timestamp, x, y, confidence
├── world_timestamps.csv   ← timestamp каждого кадра
├── video.mp4              ← видео от нагрудной камеры
└── events.csv             ← timestamp, name (если уже есть)
```

- [x] Tauri команда: открыть диалог выбора папки
- [x] FastAPI `GET /api/recordings` — сканировать папку, вернуть список
- [x] FastAPI `GET /api/recordings/{id}` — метаданные одной записи
- [ ] Страница Recordings: карточки с превью, датой, длительностью
- [x] Хранить путь к папке с записями в `localStorage`

---

### Фаза 3 — Projects (управление проектами)
**Цель:** создавать проекты, добавлять в них несколько записей

- [ ] SQLite (через `aiosqlite`) для хранения проектов — файл `data/projects.db`
- [ ] Модели: `Project`, `ProjectRecording`
- [ ] FastAPI CRUD: `/api/projects` (GET, POST, DELETE)
- [ ] FastAPI: `POST /api/projects/{id}/recordings` — добавить запись в проект
- [ ] Страница Projects: список проектов, кнопка создать, открыть
- [ ] Внутри проекта: список прикреплённых recordings

---

### Фаза 4 — Video Player с событиями и gaze
**Цель:** смотреть видео, видеть точку взгляда в реальном времени, расставлять события

- [ ] HTML5 `<video>` компонент в React
- [ ] Синхронизация `gaze.csv` с таймлайном видео
- [ ] Canvas-оверлей поверх видео — рисовать точку gaze
- [ ] Таймлайн событий снизу
- [ ] Кнопки: play/pause, scrubbing, скорость воспроизведения
- [ ] Поддержка горячих клавиш (пробел = pause, E = добавить событие)

---

### Фаза 5 — Events (ручная разметка)
**Цель:** ставить временные метки с именами в стиле TMT-A/B

**Конвенция именования:**
- TMT-A: `test01_begin` → `2` → `2_out` → `3` → `3_out` → ... → `test01_end`
- TMT-B: `test02_begin` → `02_A` → `02_A_out` → `02_3` → ... → `test02_end`

- [ ] Панель событий рядом с плеером
- [ ] Добавить событие: текущий timestamp + имя
- [ ] Быстрые шаблоны: TMT-A и TMT-B автонумерация
- [ ] Редактировать / удалять события
- [ ] Сохранять в `events.csv` рядом с записью
- [ ] FastAPI: `GET/POST/DELETE /api/recordings/{id}/events`

---

### Фаза 6 — AoI Editor (редактор зон интереса)
**Цель:** на кадре видео нарисовать зоны интереса разных форм

- [ ] Взять кадр из видео как фон canvas (через FastAPI или ffmpeg)
- [ ] Инструмент: круг — нарисовать эллипс с именем
- [ ] Инструмент: прямоугольник
- [ ] Инструмент: свободная форма (polygon)
- [ ] Список AoI слева, переключение видимости, цвет, имя
- [ ] Авто-создание AoI по узлам (для TMT: 1–25 и A–L)
- [ ] Сохранять AoI в `aoi.json` внутри проекта
- [ ] FastAPI: `GET/POST/PUT/DELETE /api/projects/{id}/aoi`

---

### Фаза 7 — Gaze анализ
**Цель:** посчитать сколько времени взгляд был в каждой AoI

- [ ] Маппинг gaze.csv точек на AoI (point-in-polygon / circle test)
- [ ] Расчёт фиксаций (velocity-based или dispersion-based алгоритм)
- [ ] Расчёт саккад
- [ ] Привязка к событиям (какие AoI посещались между event_begin и event_end)
- [ ] Визуализация: heatmap поверх кадра
- [ ] Визуализация: scanpath (траектория взгляда)

---

### Фаза 8 — Экспорт данных
**Цель:** выдать CSV в формате как у Pupil Cloud

**Файлы экспорта (по формату Pupil Cloud):**
- `gaze.csv` — raw gaze данные
- `fixations.csv` — фиксации с координатами и длительностью
- `saccades.csv` — саккады
- `aoi_fixations.csv` — какая фиксация в какой AoI
- `events.csv` — события с timestamp

- [ ] FastAPI: `POST /api/projects/{id}/export` — запустить анализ, вернуть zip
- [ ] Tauri: сохранить zip через диалог сохранения файла
- [ ] Страница Export: выбор что включать, прогресс-бар, кнопка скачать

---

### Фаза 9 — Финальная полировка
- [ ] Иконка приложения
- [ ] Установить webkit2gtk и проверить сборку `npm run tauri build`
- [ ] Упаковать Python backend как sidecar (PyInstaller → бинарник)
- [ ] Протестировать `.AppImage` на чистой системе
- [ ] README с инструкцией запуска

---

## Команды разработки

```bash
# Запустить frontend (только React + Vite, без Tauri)
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
npm run dev

# Запустить backend (FastAPI)
backend/venv/bin/uvicorn backend.app.main:app --reload --port 8000

# Запустить всё вместе (Tauri dev mode) — нужен webkit2gtk
npm run tauri dev
```

---

## Установка webkit2gtk (нужен sudo, сделать вручную в терминале)

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf
```
