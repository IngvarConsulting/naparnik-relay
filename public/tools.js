import { panelRequest } from './panel.js';

const list = document.getElementById('tool-list');
const feedback = document.getElementById('tool-feedback');
const retry = document.getElementById('tool-retry');
const rows = new Map();
const pendingTools = new Map();
let savingTools = false;
let loadingTools = false;
let toolRevision = 0;

function setFeedback(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle('panel-error', error);
}

function render({ tools }) {
  if (!Array.isArray(tools)) throw new Error('Шлюз не прислал настройки инструментов.');
  for (const tool of tools) {
    let row = rows.get(tool.id);
    if (!row) {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const text = document.createElement('span');
      const name = document.createElement('strong');
      const description = document.createElement('small');
      const input = document.createElement('input');

      input.type = 'checkbox';
      input.className = 'tool-toggle';
      input.setAttribute('role', 'switch');
      input.addEventListener('change', () => save(tool.id, input.checked));
      text.append(name, description);
      label.append(text, input);
      item.append(label);
      list.append(item);

      row = { item, input, name, description, enabled: false };
      rows.set(tool.id, row);
    }
    const name = tool.label || tool.id;
    const description = tool.description || '';
    if (row.name.textContent !== name) row.name.textContent = name;
    if (row.description.textContent !== description) row.description.textContent = description;
    row.enabled = Boolean(tool.enabled);
    const checked = pendingTools.get(tool.id) ?? row.enabled;
    if (row.input.checked !== checked) row.input.checked = checked;
  }
  const identifiers = new Set(tools.map(tool => tool.id));
  for (const [id, row] of rows) {
    if (identifiers.has(id)) continue;
    row.item.remove();
    rows.delete(id);
  }
}

async function save(id, enabled) {
  toolRevision++;
  pendingTools.set(id, enabled);
  setFeedback(feedback, '');
  if (savingTools) return;
  savingTools = true;
  try {
    while (pendingTools.size) {
      const [id, enabled] = pendingTools.entries().next().value;
      pendingTools.delete(id);
      const row = rows.get(id);
      if (!row || row.enabled === enabled) continue;
      try {
        render(await panelRequest('tools', 'PUT', { id, enabled }, { keepalive: true }));
      } catch (error) {
        if (pendingTools.has(id)) continue;
        row.input.checked = row.enabled;
        setFeedback(feedback, error.message, true);
      }
    }
  } finally {
    savingTools = false;
  }
}

async function load() {
  if (loadingTools || savingTools) return;
  loadingTools = true;
  const revision = toolRevision;
  retry.hidden = true;
  if (!rows.size) setFeedback(feedback, 'Загружаем инструменты…');
  try {
    const data = await panelRequest('tools');
    if (revision !== toolRevision) return;
    render(data);
    setFeedback(feedback, rows.size ? '' : 'Серверных инструментов пока нет.');
  } catch (error) {
    if (revision !== toolRevision) return;
    setFeedback(feedback, error.message, true);
    retry.hidden = false;
  } finally {
    loadingTools = false;
  }
}

retry.addEventListener('click', load);
window.addEventListener('focus', load);
void load();

const defaultsForm = document.getElementById('conversation-defaults');
const defaultsFeedback = document.getElementById('defaults-feedback');
const defaultsRetry = document.getElementById('defaults-retry');
const languageChoices = [...defaultsForm.querySelectorAll('input[type=radio]')];
const defaultsKeys = [...new Set(languageChoices.map(choice => choice.name))];
const controls = Object.fromEntries(defaultsKeys.map(name => [name, defaultsForm.elements.namedItem(name)]));
const programmingLanguage = 'programming_language';
const programmingPresets = new Set(['1c', 'java']);
const customLanguage = document.getElementById('programming-custom');
const programmingCode = document.getElementById('programming-code');
const pendingDefaults = new Map();
let savedDefaults;
let savingDefaults;

function readDefaults(values) {
  if (defaultsKeys.some(name => typeof values?.[name] !== 'string')) {
    throw new Error('Шлюз не прислал настройки новых диалогов.');
  }
  return values;
}

function showDefault(name, value) {
  if (name === programmingLanguage) {
    const custom = !programmingPresets.has(value);
    controls[name].value = custom ? 'other' : value;
    customLanguage.hidden = !custom;
    programmingCode.value = custom ? value : '';
    programmingCode.removeAttribute('aria-invalid');
  } else {
    controls[name].value = value;
  }
}

async function loadDefaults() {
  defaultsRetry.hidden = true;
  defaultsForm.setAttribute('aria-busy', 'true');
  setFeedback(defaultsFeedback, 'Загружаем настройки…');
  try {
    savedDefaults = readDefaults(await panelRequest('conversation-defaults'));
    for (const name of defaultsKeys) showDefault(name, savedDefaults[name]);
    for (const choice of languageChoices) choice.disabled = false;
    programmingCode.disabled = false;
    setFeedback(defaultsFeedback, '');
  } catch (error) {
    setFeedback(defaultsFeedback, error.message, true);
    defaultsRetry.hidden = false;
  } finally {
    defaultsForm.removeAttribute('aria-busy');
  }
}

async function saveDefaults() {
  if (savingDefaults) return;
  while (pendingDefaults.size) {
    const changes = [...pendingDefaults];
    pendingDefaults.clear();
    savingDefaults = Object.fromEntries(changes);
    try {
      const previous = savedDefaults;
      savedDefaults = readDefaults(await panelRequest('conversation-defaults', 'PATCH', savingDefaults, { keepalive: true }));
      for (const name of defaultsKeys) {
        if (pendingDefaults.has(name) || previous[name] === savedDefaults[name]) continue;
        if (name === programmingLanguage && controls[name].value === 'other' && programmingCode.value !== previous[name]) continue;
        showDefault(name, savedDefaults[name]);
      }
    } catch (error) {
      for (const [name, value] of changes) {
        if (name === programmingLanguage && controls[name].value === 'other') continue;
        if (!pendingDefaults.has(name) && controls[name].value === value) showDefault(name, savedDefaults[name]);
      }
      setFeedback(defaultsFeedback, error.message, true);
    } finally {
      savingDefaults = undefined;
    }
  }
}

function changeDefault(name, value) {
  if (!savedDefaults) return;
  setFeedback(defaultsFeedback, '');
  const currentValue = pendingDefaults.get(name) ?? savingDefaults?.[name] ?? savedDefaults[name];
  if (value === currentValue) return;
  pendingDefaults.set(name, value);
  void saveDefaults();
}

function changeProgrammingCode() {
  if (customLanguage.hidden || !savedDefaults) return;
  const value = programmingCode.value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.+#-]{0,31}$/.test(value)) {
    programmingCode.setAttribute('aria-invalid', 'true');
    setFeedback(defaultsFeedback, 'Укажите код языка программирования, например python.', true);
    return;
  }
  programmingCode.removeAttribute('aria-invalid');
  programmingCode.value = value;
  if (programmingPresets.has(value)) {
    const focused = document.activeElement === programmingCode;
    showDefault(programmingLanguage, value);
    if (focused) languageChoices.find(choice => choice.name === programmingLanguage && choice.value === value)?.focus();
  }
  changeDefault(programmingLanguage, value);
}

for (const choice of languageChoices) choice.addEventListener('change', () => {
  if (choice.name === programmingLanguage) {
    if (choice.value === 'other') {
      customLanguage.hidden = false;
      setFeedback(defaultsFeedback, '');
      return;
    }
    showDefault(choice.name, choice.value);
  }
  changeDefault(choice.name, choice.value);
});
programmingCode.addEventListener('change', changeProgrammingCode);
defaultsForm.addEventListener('submit', event => {
  event.preventDefault();
  changeProgrammingCode();
});
defaultsRetry.addEventListener('click', loadDefaults);
void loadDefaults();
