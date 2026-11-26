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

3. Добавьте модель с ID `naparnik`, сохраните провайдера и выполните настройку веб-инструментов ниже. Затем выберите `naparnik` в новой сессии.

В версиях без **Custom model API** откройте карточку **DeepSeek** в **Settings → Models**. Введите локальный ключ в **API key**, а адрес из таблицы в **Customized settings → Base URL**. Нажмите **Add model**, укажите ID `naparnik` и нажмите **Apply**. Адрес и ключ карточки действуют на все её модели. [Настройка провайдеров Harness](https://deepseek-harness.github.io/deepseek-harness/en/guide/providers)

### Веб-инструменты

Для сессий Напарника выключите встроенный `web_search`. Harness выполняет его отдельным запросом. При использовании карточки DeepSeek запрос может отправить локальный ключ Relay на сервер DeepSeek и получить `401`. [Аутентификация поиска Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-search-deepseek/README.md#authentication)

1. В **Agent presets** найдите пресет, который используется в сессиях Напарника. Обычно это **Standard**. Откройте **View configuration**, чтобы посмотреть список плагинов пресета. [Пресеты Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-agent-preset/README.md#use-this-package)
2. В дочернем плагине `tool-web` задайте `search: false` и `fetch: true`. Если ваша версия позволяет редактировать пресет в интерфейсе, сохраните изменения там. Для просмотра без редактирования используйте `cordis.patch.yml` активного профиля. [Настройки веб-инструментов](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/tool-web/README.md)

   В Desktop пользовательский файл находится в `$DSH_HOME/profiles/desktop/cordis.patch.yml` (`~/.dsh/profiles/desktop/cordis.patch.yml` при расположении по умолчанию). Для **Standard**, **PTC** и **Creator** записи пресетов называются `preset-standard`, `preset-ptc` и `preset-cordis` соответственно. Если записи ещё нет, добавьте её с нужным `id` и перенесите полный список плагинов из **View configuration** в её `config.plugins`. Полный список сохраняет остальные инструменты пресета. [Исходный пресет Standard](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/web-app/presets/standard.patch.yml)

   Измените два поля внутри `config` элемента `tool-web`. Ниже показан этот элемент из списка Standard.

   ```yaml
   - id: tool-web
     name: '@deepseek-ai/dsh-tool-web'
     config:
       search: false
       fetch: true
       searchTimeoutMs: 60000
   ```

3. В **Plugins → Built-in plugin settings → Web search and fetch** установите **Fetch → Direct fetch**. `web_fetch` будет открывать публичные страницы напрямую по заданным URL. Создайте новую сессию с настроенным пресетом. [Прямой HTTP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/web/web-fetch-http/README.md)

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

## Проверка

Отправьте в новом чате `naparnik` короткий запрос, например «Ответь одним словом: готово». Проверьте ответ в клиенте и запись в журнале панели Relay. Оба клиента используют штатный потоковый режим своего протокола.

В Harness для проверки веб-инструментов попросите открыть известный публичный URL. В карточке инструмента должен появиться `web_fetch`.

Если подключения нет, откройте `http://127.0.0.1:47831/health` с портом вашего Relay. Ответ с `"ready": true` подтверждает, что шлюз запущен. Если шлюз отвечает, проверьте локальный ключ, Base URL и ID модели по инструкции для клиента.
