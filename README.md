# devastbotnet

Инструментарий и архитектура роевого RTS-оркестратора для Devast.io. Начинается с **Phase 0 — reverse engineering протокола**: без схемы пакетов остальная система не имеет входа.

Статус: Phase 0 инструментарий готов (захват, схема, парсер, фикстуры, анализатор). Демо роя работает на уровне транспорта: `demo:swarm` поднимает 10 headless-сессий на один игровой сервер с отчётом и GUI. Семантика игровых кадров (`0x14`/`0x47`) — гипотезы, поэтому поведение ботов в игре ещё не реализовано (Phase 1+).

- Спецификация: [`docs/ARCHITECTURE_V2.md`](docs/ARCHITECTURE_V2.md)
- Методика реверса: [`docs/PHASE0-PLAYBOOK.md`](docs/PHASE0-PLAYBOOK.md)
- Находки: [`docs/PHASE0-FINDINGS-2026-11-11.md`](docs/PHASE0-FINDINGS-2026-11-11.md), [`docs/PHASE0-FINDINGS-2026-11-12.md`](docs/PHASE0-FINDINGS-2026-11-12.md)
- Исходный бриф: [`docs/brief/`](docs/brief/)

> **Принятый риск.** Массовые боты, обход IP-лимитов и автоматизация нарушают правила Devast.io. Возможен бан аккаунтов. Основной аккаунт оператора изолирован: bridge работает только на чтение и не отправляет пакеты в игровой сокет. Подробности — ADR-008 в спецификации.

## Требования

- Node.js ≥ 22 (проверено на 24.12)
- Python ≥ 3.11 + `pip install -r requirements.txt` (`curl_cffi>=0.17` — 0.16.x крашит процесс нативно на `recv`)
- Tampermonkey (Chrome/Edge/Firefox) для сниффера
- `npm install`
- Для живого роя ≥ 2 внешних IP: лимит Devast.io — 6 сессий с одного IP (6 direct + прокси, по умолчанию `http://127.0.0.1:10809`)

## Быстрый старт Phase 0

```bash
npm install
npm run build
npm test

# 1. Приёмник дампов
npm run recorder
# слушает 127.0.0.1:8787, сессии в ./sessions

# 2. Сниффер в Tampermonkey
# установить tools/sniffer/master-client-sniffer.user.js,
# открыть Devast.io: [devast-tap] transport ready, [devast-tap] in/out N

# 3. Анализ захвата
npm run analyze -- sessions/<dir>
```

## Демо роя

```bash
# Симуляция 10 ботов (без сети): WorldStore, квоты, IFF, friendly-fire, GUI
npm run demo:simulate

# 100 ботов dry-run: планировщик, квоты, бюджет IP
npm run demo:scale -- --bots 100 --dry-run

# Живой прогон: 10 headless-сессий на один сервер + тактический GUI
npm run demo:swarm -- --bots 10 --seconds 20
# отчёт: sessions/demo-swarm/report.json

# Долгоживущий мост для ручных тестов команд из GUI
npm run swarm:live
```

`demo:swarm` делает: поднимает GUI на `127.0.0.1:4173`, захватывает свежий токен на бота через headless Chrome (CDP) и сразу подключает его (`curl_cffi`, chrome-имперсонация TLS), половина ботов — через прокси. Живой скриншот GUI можно снять вручную с `http://127.0.0.1:4173`.

Для `demo:swarm` и `swarm:live` нужен локальный `C:/R/Temp/devast-session.json` с полем `joinHex`: это ранее захваченный join-кадр, а не файл из репозитория. `tools/capture/session-tap.mjs` умеет записать его из сессии Chrome с CDP на порту 9333. Файл также содержит URL с токеном; не публикуйте его.

Отчёт `report.json` — честный: `bots_connected` — только подтверждённые коннекты; позиции ботов в GUI — якоря планировщика (координаты `0x14` не декодированы); квоты/бой/master-view считаются реальными модулями TS (`tools/demo/swarm_checks.mjs`). В наблюдениях сервер закрывал соединение через несколько секунд; причина не установлена, семантика handshake не подтверждена (см. находки). `demo:swarm` завершается кодом 0, только если все критерии выполнены; при любой ошибке пишет отчёт с причиной.

## Схема протокола

Единственный источник истины — `config/protocol-schema.json`. Числовых опкодов и смещений в бизнес-коде нет: парсер (`src/protocol/`) читает схему. Статусы честные: `hypothesis`, пока кадр не подтверждён воспроизведением; `unknown_0xNN` — штатное событие, не исключение.

## Инварианты эксплуатации

- Master client оператора — read-only: сниффер только читает трафик и пишет дампы, ничего не модифицирует и не отправляет.
- Управляемые Chrome-процессы для ботов/захвата запускаются с `--mute-audio`; основной браузер оператора не мьютится.
- `sessions/`, реальные дампы и ники не коммитятся; cookies/токены не логируются.
- Каждый запуск ограничен бюджетом времени — никаких бесконечных ожиданий.

## Сборки и проверки

```bash
npm test                  # TS-тесты (strict) + harness-тесты сниффера
npm run fixtures:check    # парсер против захваченных и синтетических фикстур
npm run check:userscript  # синтаксис сниффера
npm run build             # tsc -p tsconfig.json
```

Python-скрипты (`tools/demo/*.py`) — стандартная библиотека + `curl_cffi`; транспорт ботов вынесен в subprocess `swarm_io.py`, чтобы нативный сбой TLS не убивал оркестратор.
