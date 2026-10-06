# Мост транскрибации голосовых сообщений

HTTP-сервис для транскрибации голосовых сообщений.  
Скачивает аудио по URL, распознаёт речь через OpenAI-совместимый API, очищает типичные галлюцинации ASR и при необходимости пропускает текст через LLM для исправления ошибок и форматирования.

Подходит для интеграции с коробочной версией [YouGile](https://ru.yougile.com/).

## Возможности

- Транскрибация через любой OpenAI-совместимый `/audio/transcriptions`
- Опциональная постобработка текста второй моделью (исправление ошибок, пунктуация, абзацы)
- Автоочистка известных галлюцинаций ASR (DimaTorzok и аналоги)
- Лимиты размера/длины, rate-limit, ограничение параллелизма

## API

```
GET /transcribe?url=<URL аудио>&lang=ru&model=turbo
```

| Параметр | Обязательный | Описание |
|----------|--------------|----------|
| `url` | да | Публичный или доступный URL аудиофайла |
| `lang` | нет | Язык распознавания (по умолчанию `ru`) |
| `model` | нет | Подсказка клиента (информативно, на выбор модели API не влияет) |

**Ответ:** HTTP 200, `Content-Type: text/plain; charset=utf-8`, тело — текст транскрипции.

```
GET /health  →  200 ok
```

## Быстрый старт

```bash
cp env.example .env
# заполните TRANSCRIPTION_API_BASE, TRANSCRIPTION_API_KEY, TRANSCRIPTION_MODEL и остальные обязательные переменные

docker compose up -d --build
curl http://localhost:8080/health
```

## Подключение к YouGile (коробочная версия)

В `conf.json` коробки укажите адрес сервиса так, как его видит сервер YouGile (имя контейнера в общей Docker-сети или IP), и перезапустите коробку:

```json
{
  "transcriptionServerHost": "http://transcription-bridge:8080"
}
```

Аудиофайлы должны быть доступны из контейнера моста. Если публичный `mainPageUrl` из контейнера недоступен, задайте внутренний адрес:

```env
INTERNAL_AUDIO_BASE=http://yougile:8001
ALLOWED_HOSTS=yougile
```

## Переменные окружения

Значения по умолчанию в коде **отсутствуют** — все обязательные переменные нужно задать явно.

### Обязательные

| Переменная | Описание |
|---|---|
| `AUDIO_FETCH_TIMEOUT_MS` | Таймаут скачивания аудио (мс) |
| `MAX_AUDIO_BYTES` | Максимальный размер аудиофайла (байты) |
| `MAX_AUDIO_DURATION_SEC` | Максимальная длительность аудио (секунды) |
| `MAX_OUTPUT_CHARS` | Максимальная длина текста ответа (символы) |
| `API_TIMEOUT_MS` | Таймаут запроса к API транскрибации (мс) |
| `MAX_CONCURRENT` | Лимит одновременных транскрибаций |
| `RATE_LIMIT_PER_MIN` | Максимум запросов с одного IP в минуту |
| `TRANSCRIPTION_API_BASE` | Базовый URL API транскрибации (без `/` в конце) |
| `TRANSCRIPTION_API_KEY` | API-ключ сервиса транскрибации |
| `TRANSCRIPTION_MODEL` | ID модели транскрибации |
| `PORT` | Порт HTTP-сервера |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

### Опциональные

| Переменная | Описание |
|---|---|
| `TRANSCRIPTION_PROMPT` | Промпт для модели транскрибации (язык, термины) |
| `INTERNAL_AUDIO_BASE` | Внутренний base URL: origin входящего URL заменяется на этот, путь сохраняется |
| `ALLOWED_HOSTS` | Белый список хостов (через запятую). Пусто = любые. Проверяется после подмены origin |
| `CORRECTION_ENABLED` | `true` / `false` — постобработка второй моделью |
| `CORRECTION_API_BASE` | Base URL API коррекции (`/chat/completions`) |
| `CORRECTION_API_KEY` | API-ключ модели коррекции |
| `CORRECTION_MODEL` | ID модели коррекции |
| `CORRECTION_PROMPT` | Системный промпт для исправления текста |
| `CORRECTION_TIMEOUT_MS` | Таймаут коррекции (мс), по умолчанию `30000` |

При `CORRECTION_ENABLED=true` переменные `CORRECTION_API_*` и `CORRECTION_PROMPT` обязательны.

### Пример `.env` (сообщения до ~1 минуты)

```env
AUDIO_FETCH_TIMEOUT_MS=60000
MAX_AUDIO_BYTES=8388608
MAX_AUDIO_DURATION_SEC=90
MAX_OUTPUT_CHARS=2000
API_TIMEOUT_MS=120000
MAX_CONCURRENT=5
RATE_LIMIT_PER_MIN=30

TRANSCRIPTION_API_BASE=https://example.com/api/v1
TRANSCRIPTION_API_KEY=sk-...
TRANSCRIPTION_MODEL=openai/whisper-large-v3-turbo
TRANSCRIPTION_PROMPT=Текст может содержать русский и английский языки, технические термины и названия. Сохраняй оригинальный язык каждого слова.

PORT=8080
LOG_LEVEL=info

# Внутренняя сеть (опционально)
# INTERNAL_AUDIO_BASE=http://yougile:8001
# ALLOWED_HOSTS=yougile

# Коррекция текста (опционально)
# CORRECTION_ENABLED=true
# CORRECTION_API_BASE=https://example.com/api/v1
# CORRECTION_API_KEY=sk-...
# CORRECTION_MODEL=google/gemini-2.0-flash
# CORRECTION_TIMEOUT_MS=30000
# CORRECTION_PROMPT=Ты — редактор текста из распознавания речи. ...
```

Полный шаблон — в [`env.example`](env.example).

## Скачивание аудио по внутренней сети

Если файлы недоступны с публичного домена, задайте внутренний адрес:

```env
INTERNAL_AUDIO_BASE=http://yougile:8001
ALLOWED_HOSTS=yougile
```

```
https://example.com/files/voice/abc.ogg
        ↓
http://yougile:8001/files/voice/abc.ogg
```

## Очистка галлюцинаций ASR

На тишине модели иногда вставляют «водяные знаки» (см. [dimatorzok.com](https://dimatorzok.com/ru/kak-ubrat/)).

Сервис автоматически удаляет:

- «Субтитры создавал / сделал DimaTorzok» и варианты
- «Subtitles by DimaTorzok», «Subtitles by the Amara.org community»
- строки целиком из фраз вроде «Спасибо за просмотр», «Thank you for watching»

Дополнительно при вызове API выставляется `temperature=0`.  
Очистка выполняется после транскрибации и после коррекции.

## Опциональная коррекция текста

Второй этап — прогон распознанного текста через LLM:

1. Модель транскрибации → сырой текст  
2. LLM → исправления, пунктуация, абзацы, без слов-паразитов  

Для коротких сообщений по скорости и цене удобны:

- `google/gemini-2.0-flash` / Flash-Lite  
- `openai/gpt-4o-mini` и аналогичные nano/luna  
- быстрые Qwen Flash  

## Маркеры ошибок

| Ситуация | Текст |
|---|---|
| Rate-limit | `[Транскрипция недоступна: слишком много запросов, попробуйте позже]` |
| Перегрузка | `[Транскрипция недоступна: сервис временно перегружен]` |
| Нет `url` | `[Транскрипция недоступна: отсутствует ссылка на файл]` |
| Некорректный URL | `[Транскрипция недоступна: некорректная ссылка на файл]` |
| Файл слишком большой | `[Транскрипция недоступна: файл слишком большой]` |
| Ошибка скачивания | `[Транскрипция недоступна: не удалось скачать файл]` |
| Ошибка API / прочее | `[Транскрипция недоступна]` |

## Логи

```bash
docker compose logs -f transcription-bridge
```

| Маркер в логе | Значение |
|---|---|
| `Конфиг: …` | Старт, параметры |
| `Запрос: GET /transcribe?…` | Входящий запрос |
| `URL переписан на внутренний` | Сработала `INTERNAL_AUDIO_BASE` |
| `Аудио: получено N байт` | Файл скачан |
| `API: 200 …` | Успешная транскрибация |
| `Коррекция: 200 …` | Успешная постобработка |
| `Транскрибация: OK …` | Итоговый ответ клиенту |

## Безопасность

Предполагается работа во внутренней сети. Не публикуйте сервис в интернет без дополнительной защиты.

## Лицензия

MIT

