'use strict';
const keyEl = document.getElementById('key');
const statusEl = document.getElementById('status');
const buttons = ['save','test','test-model','clear'].map(id => document.getElementById(id));
function status(text, kind = '') {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
}
function busy(value) { buttons.forEach(button => button.disabled = value); }
function redact(error) {
  return String(error?.message || error || 'Неизвестная ошибка')
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[API-KEY]').slice(0, 280);
}
async function load() {
  const data = await chrome.storage.local.get('openrouterKey');
  keyEl.value = data.openrouterKey || '';
  status(keyEl.value ? 'Ключ сохранён в этом браузере.' : 'Ключ пока не указан.');
}
document.getElementById('toggle').addEventListener('click', event => {
  keyEl.type = keyEl.type === 'password' ? 'text' : 'password';
  event.target.textContent = keyEl.type === 'password' ? 'Показать' : 'Скрыть';
});
document.getElementById('save').addEventListener('click', async () => {
  const key = keyEl.value.trim();
  if (!/^sk-or-v1-[A-Za-z0-9_-]+$/.test(key)) {
    status('Введите действительный ключ вида sk-or-v1-...', 'error'); return;
  }
  try {
    busy(true);
    await chrome.storage.local.set({ openrouterKey: key });
    status('Ключ сохранён. Теперь можно использовать Alt+X и Alt+Z.', 'success');
  } catch (error) { status(redact(error), 'error'); }
  finally { busy(false); }
});
document.getElementById('clear').addEventListener('click', async () => {
  try {
    busy(true);
    await chrome.storage.local.remove('openrouterKey');
    keyEl.value = '';
    status('Ключ удалён из локального хранилища.', 'success');
  } catch (error) { status(redact(error), 'error'); }
  finally { busy(false); }
});
async function check(type) {
  try {
    busy(true);
    status(type === 'AI_TEST_KEY' ? 'Проверка авторизации...' : 'Тестовый запрос к модели...');
    // Use the key typed in the input, even if not saved yet.
    const result = await chrome.runtime.sendMessage({ type, key: keyEl.value.trim() });
    if (!result?.ok) throw new Error(result?.error || 'Нет ответа от расширения');
    if (type === 'AI_TEST_KEY') {
      const tier = result.isFreeTier === true ? ' (бесплатный аккаунт)' : '';
      status(`Ключ работает${tier}.`, 'success');
    } else {
      status(`Модель ответила за ${result.durationMs} мс. ${String(result.answer || '').slice(0, 75)}`, 'success');
    }
  } catch (error) { status(redact(error), 'error'); }
  finally { busy(false); }
}
document.getElementById('test').addEventListener('click', () => check('AI_TEST_KEY'));
document.getElementById('test-model').addEventListener('click', () => check('AI_TEST_MODEL'));
void load().catch(error => status(redact(error), 'error'));
