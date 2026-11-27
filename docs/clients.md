# Подключение клиентов к Naparnik Relay

## Перед подключением

1. Запустите Naparnik Relay и откройте его панель.
2. Нажмите **Подключить аккаунт** и введите ключ из раздела «Ключи доступа» 1С:Напарника.
3. Скопируйте **локальный API key** из панели Relay. Его нужно вставить в настройки клиента. При нестандартном порте подставьте порт из панели Relay вместо `47831` в адресах ниже.

## DeepSeek Harness

### Подключение модели

1. Откройте **Settings → Models → Add model provider** и выберите **Custom model API**. Этот вариант хранит подключение Relay в отдельном провайдере.
2. Введите настройки из таблицы.

   | Поле | Значение |
   | --- | --- |
   | Provider ID | `naparnik-relay` |
   | Display name | `1С:Напарник` |
   | Base URL | `http://127.0.0.1:47831` |
   | API protocol | **Anthropic Messages** |
   | API key | Локальный ключ из панели Relay |

3. Добавьте модель с ID `naparnik`, сохраните провайдера и выберите `naparnik` в новой сессии.

В версиях без **Custom model API** откройте карточку **DeepSeek** в **Settings → Models**. Введите локальный ключ в **API key**, а адрес из таблицы в **Customized settings → Base URL**. Нажмите **Add model**, укажите ID `naparnik` и нажмите **Apply**. Адрес и ключ карточки действуют на все её модели. [Настройка провайдеров Harness](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers)

Встроенный `web_search` использует собственный провайдер поиска. Если хотите пользоваться только поиском Напарника, выключите поиск DeepSeek в настройках Harness. Клиентский `web_fetch` при этом можно использовать в режиме **Direct fetch**. [Настройки поиска Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-deepseek/README.md#authentication)

## ZCode

1. Откройте **Model settings → Add provider → Create custom provider**.
2. Задайте имя провайдера, например `1С:Напарник`, и введите настройки из таблицы.

   | Поле | Значение |
   | --- | --- |
   | Base URL | `http://127.0.0.1:47831/v1` |
   | API format | **Chat Completions** |
   | API key | Локальный ключ из панели Relay |

3. Нажмите **Add model**, добавьте и включите модель с ID `naparnik`.
4. Нажмите **Test model**. После успешной проверки откройте новый чат и выберите `naparnik`. [Настройка провайдеров ZCode](https://zcode.z.ai/en/docs/configuration#custom-providers-anthropic--openai-compatible)

## OpenCode 1.x

Добавьте провайдера в штатный `opencode.json`. Перед запуском OpenCode задайте `NAPARNIK_RELAY_API_KEY` локальным ключом из панели Relay. Для выбора в уже открытом OpenCode используйте `/models` и выберите `1С:Напарник`. [Пользовательский провайдер OpenCode 1.19.6](https://github.com/anomalyco/opencode/blob/v1.19.6/packages/web/src/content/docs/providers.mdx#custom-provider)

```json
{
  "model": "relay/naparnik",
  "provider": {
    "relay": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Naparnik Relay",
      "options": {
        "baseURL": "http://127.0.0.1:47831/v1",
        "apiKey": "{env:NAPARNIK_RELAY_API_KEY}"
      },
      "models": { "naparnik": { "name": "1С:Напарник" } }
    }
  }
}
```

## Claude Code

Для подключения нужен Naparnik Relay 1.0.13 или новее. Установите Claude Code CLI и выполните `claude --version`. Если команда недоступна сразу после установки, откройте новый терминал. [Установка Claude Code](https://code.claude.com/docs/en/setup)

Укажите адрес Relay без суффикса `/v1` и подставьте **локальный API key** из панели Relay. Затем запустите Claude Code с моделью `naparnik`. Переменные действуют в текущем терминале. [Настройка шлюза Claude Code](https://code.claude.com/docs/en/llm-gateway-connect)

**Windows PowerShell**

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:47831'
$env:ANTHROPIC_AUTH_TOKEN = '<локальный ключ Relay>'
claude --model naparnik
```

**macOS и Linux, Bash или Zsh**

```sh
export ANTHROPIC_BASE_URL='http://127.0.0.1:47831'
export ANTHROPIC_AUTH_TOKEN='<локальный ключ Relay>'
claude --model naparnik
```

Потоковый текстовый ответ проверен в Claude Code 2.1.332. Официальная поддержка Anthropic при подключении через шлюз распространяется на модели Claude. [Совместимость шлюзов Claude Code](https://code.claude.com/docs/en/llm-gateway)

## Другие клиенты

В штатных настройках провайдера укажите локальный API-ключ Relay и модель `naparnik`. Выберите протокол, который поддерживает клиент, и задайте Base URL так, чтобы конечный адрес совпадал с маршрутом в таблице. Некоторые клиенты добавляют `/v1` сами.

| Протокол | Конечный адрес генерации |
| --- | --- |
| Anthropic Messages | `http://127.0.0.1:47831/v1/messages` |
| OpenAI Chat Completions | `http://127.0.0.1:47831/v1/chat/completions` |

## Проверка

В новом чате `naparnik` попросите запомнить слово, затем спросите это слово следующим сообщением. В трассировке второй запрос должен продолжить диалог по `parent_uuid` первого ответа. Relay может сопоставить ветку по истории `messages`, когда клиент не передаёт ID сессии.

Если подключения нет, откройте `http://127.0.0.1:47831/health` с портом вашего Relay. Ответ с `"ready": true` подтверждает, что шлюз запущен. Если шлюз отвечает, проверьте локальный ключ, Base URL и ID модели по инструкции для клиента.
