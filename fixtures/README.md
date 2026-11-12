# Fixtures

Регрессионные дампы кадров: `(schema, bytes)` → детерминированный `DecodeResult`. Механизм проверки — `npm run fixtures:check`.

## Структура

```
fixtures/<name>/
  meta.json       { name, gameBuild, schema, frames, expected, strict }
  frames.jsonl    {"dir":"c2s"|"s2c","hex":"..."} или {"dir":"s2c","kind":"text","text":"[...]"}
  expected.json   снапшот DecodeResult (генерируется, но коммитится)
```

`schema` — путь к JSON-схеме относительно `meta.json` (обычно `../../config/protocol-schema.json`).

## Правила

- Фикстура привязана к `gameBuild`; при обновлении игры добавляется новая, старая не удаляется.
- `expected.json` обновляется только через `npm run fixtures:update` после ручной проверки diff. Автоматическая подгонка снапшота под изменившийся парсер запрещена (AGENTS.md).
- `strict: true` означает: любой unknown/structural failure валит проверку. Для схемы, где ещё не все опкоды подтверждены, ставьте `false`, пока не дойдёте до exit criteria Phase 0.
- Реальные кадры обезличиваются: ники/клан-теги заменяются, байты координат и опкодов не меняются.

## Synthetic

`fixtures/captured-frankfurt4` — реальные текстовые кадры сервера (opcodes 2/5/7/9), ники/теги/токен заменены. `fixtures/synthetic` — не результат захвата игры. Это проверка самого конвейера: u32, f32, length-prefixed string. Не использовать как доказательство знания протокола.
