import { panelRequest } from './panel.js';
import { renderPacketBody } from './trace-syntax.js';

const $ = id => document.getElementById(id);

function notice(text) {
  const message = document.createElement('p');
  message.className = 'panel-feedback';
  message.textContent = text;
  return message;
}

function render({ time, error, packets }) {
  const date = new Date(time);
  if (Number.isFinite(date.getTime())) {
    const stamp = $('diagnostic-time');
    stamp.dateTime = date.toISOString();
    stamp.textContent = date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });
    stamp.hidden = false;
  }
  $('diagnostic-error').textContent = error.message;
  const request = packets.find(packet => packet.kind === 'request');
  const requestBody = $('diagnostic-request');
  if (request) {
    requestBody.append(renderPacketBody(`${request.method} ${request.path}\nAuthorization: Bearer [скрыто]`));
    const response = packets.find(packet => packet.kind === 'response' || packet.kind === 'error');
    const responseBody = $('diagnostic-response');
    $('diagnostic-status').textContent = Number.isInteger(response?.status) ? 'HTTP ' + response.status : 'Нет HTTP-ответа';
    $('diagnostic-response-section').hidden = false;
    if (response?.body !== undefined && response.body !== '') responseBody.append(renderPacketBody(response.body));
    else if (response?.kind === 'response') responseBody.append(notice('Ответ без тела.'));
    if (response?.truncated) responseBody.append(notice('Тело ответа показано частично.'));
  } else {
    requestBody.append(notice('Запрос к Напарнику не отправлялся.'));
  }
  $('diagnostic-feedback').textContent = '';
  $('diagnostic-exchange').hidden = false;
}

const attempt = new URLSearchParams(location.search).get('attempt');
try {
  if (!attempt) throw new Error('Откройте диагностику по ссылке рядом с ошибкой авторизации.');
  render(await panelRequest('auth-diagnostics?attempt=' + encodeURIComponent(attempt)));
} catch (error) {
  const feedback = $('diagnostic-feedback');
  feedback.classList.add('panel-error');
  feedback.textContent = error.message;
}
