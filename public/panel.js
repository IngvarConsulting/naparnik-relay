export async function panelRequest(path, method = 'GET', data, { keepalive = false } = {}) {
  let response;
  try {
    response = await fetch('/panel/' + path, {
      method,
      headers: { 'X-Relay-Panel': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      keepalive
    });
  } catch {
    throw new Error('Нет связи со шлюзом. Запустите программу ещё раз.');
  }
  const value = await response.json().catch(() => null);
  if (!response.ok || value === null) {
    const error = new Error(value?.error?.message || 'Шлюз вернул ошибку.');
    if (typeof value?.error?.diagnosticId === 'string') error.diagnosticId = value.error.diagnosticId;
    throw error;
  }
  return value;
}
