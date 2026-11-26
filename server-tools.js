const its = 'its';
const webFetch = 'mcp__web__fetch';
const catalog = new Map([
  [its, { label: '1С:ИТС', description: 'Поиск и чтение материалов ИТС' }],
  ['mcp__knowledge-hub__Search_Documentation', { label: 'Поиск по документации' }],
  ['mcp__knowledge-hub__Fetch_Documentation', { label: 'Чтение документации' }],
  ['mcp__syntax-checker__validate', { label: 'Проверка синтаксиса' }],
  [webFetch, { label: 'Чтение веб-страниц' }],
  ['RenameChat', { label: 'Переименование чата' }]
]);

function toolId(name) {
  return /^(?:mcp__knowledge-hub__)?(?:Search|Fetch)_ITS$/.test(name) ? its : name;
}

export function serverToolEnabled(settings, name) {
  const id = toolId(name);
  return Object.hasOwn(settings ?? {}, id) ? settings[id] === true : id !== webFetch;
}

export function serverToolOptions(settings, records) {
  const observed = [...records.history, ...records.sessions.flatMap(session => session.history ?? [])];
  const ids = new Set([
    ...catalog.keys(),
    ...Object.keys(settings ?? {}),
    ...observed.filter(entry => typeof entry.name === 'string' && entry.name).map(entry => toolId(entry.name))
  ]);
  return [...ids].map(id => ({
    id,
    ...(catalog.get(id) ?? { label: id.split('__').at(-1) }),
    enabled: serverToolEnabled(settings, id)
  }));
}
