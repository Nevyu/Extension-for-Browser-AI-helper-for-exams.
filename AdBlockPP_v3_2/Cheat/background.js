'use strict';

const MODEL = 'nvidia/nemotron-3.5-lightning:free';
const API_BASE = 'https://openrouter.ai/api/v1';
const MAX_PROMPT_LENGTH = 12000;
const API_TIMEOUT_MS = 90000;
const KEY_STORAGE_NAME = 'openrouterKey';

// Content scripts cannot read local extension storage, including API credentials.
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'process-selected-text',
      title: 'Обработать выделенный текст',
      contexts: ['selection']
    });
  });
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.commands.onCommand.addListener((command, tab) => {
  const action = command === 'copy-ai-answer' ? 'copy'
    : command === 'show-ai-answer' ? 'show' : null;
  if (!action) return;
  void sendAction(tab?.id, action).catch(error => {
    console.warn('[AdBlock++] Shortcut failed:', safeError(error));
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'process-selected-text') return;
  void sendAction(tab?.id, 'show', info.selectionText || '').catch(error => {
    console.warn('[AdBlock++] Context menu failed:', safeError(error));
  });
});

async function sendAction(tabId, action, selectedText = '') {
  if (!tabId) {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = tabs[0]?.id;
  }
  if (!tabId) throw new Error('Активная вкладка не найдена');
  const payload = { type: 'AI_ACTION', action, selectedText };
  try {
    await chrome.tabs.sendMessage(tabId, payload);
    return;
  } catch (_) {
    // Load the helper only when invoked; avoids touching every page by default.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
  await chrome.tabs.sendMessage(tabId, payload);
}

function safeError(error) {
  return String(error?.message || error || 'Неизвестная ошибка')
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[API-KEY]')
    .slice(0, 300);
}

function httpReason(status) {
  if (status === 401) return 'Неверный или отозванный API-ключ';
  if (status === 402) return 'Недостаточно средств или доступ к модели ограничен';
  if (status === 403) return 'Доступ к API запрещён';
  if (status === 404) return 'Модель или endpoint не найдены';
  if (status === 408) return 'Истекло время ожидания сервера';
  if (status === 429) return 'Превышен лимит запросов';
  if (status >= 500) return 'Временная ошибка OpenRouter или провайдера';
  return 'Запрос отклонён';
}

async function getKey(overrideKey) {
  if (typeof overrideKey === 'string' && overrideKey.trim()) return overrideKey.trim();
  const stored = await chrome.storage.local.get(KEY_STORAGE_NAME);
  const key = String(stored[KEY_STORAGE_NAME] || '').trim();
  if (!/^sk-or-v1-[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('API-ключ не настроен. Откройте настройки расширения (нажмите на значок расширения).');
  }
  return key;
}

async function fetchWithTimeout(path, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    return await fetch(`${API_BASE}${path}`, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Тайм-аут запроса: OpenRouter не ответил за 90 секунд');
    }
    throw new Error('Ошибка сети: не удалось подключиться к OpenRouter');
  } finally {
    clearTimeout(timeout);
  }
}

async function validateKey(rawKey) {
  const key = await getKey(rawKey);
  const response = await fetchWithTimeout('/key', {
    headers: { Authorization: `Bearer ${key}` }
  });
  if (!response.ok) throw new Error(`${httpReason(response.status)} (HTTP ${response.status})`);
  const result = await response.json().catch(() => ({}));
  return { valid: true, isFreeTier: result?.data?.is_free_tier ?? null };
}

function flattenAnswer(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('\n').trim();
  }
  return '';
}

async function generateAnswer(prompt, rawKey) {
  const key = await getKey(rawKey);
  if (!prompt || !prompt.trim()) throw new Error('Выделите текст, чтобы отправить запрос');
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`Слишком длинный текст: максимум ${MAX_PROMPT_LENGTH} символов`);
  }
  const started = Date.now();
  const response = await fetchWithTimeout('/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: 'Answer the provided text accurately and concisely in the same language. When uncertain, acknowledge it.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1024,
      stream: false
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Return a stable diagnostic and avoid printing response headers, prompts or keys.
    throw new Error(`${httpReason(response.status)} (HTTP ${response.status})`);
  }
  const answer = flattenAnswer(data?.choices?.[0]?.message?.content);
  if (!answer) throw new Error('API вернул пустой ответ (Empty response)');
  return { answer, model: data?.model || MODEL, durationMs: Date.now() - started };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !['AI_GENERATE', 'AI_TEST_KEY', 'AI_TEST_MODEL'].includes(message.type)) return false;
  const started = Date.now();
  (async () => {
    if (message.type === 'AI_TEST_KEY') {
      if (sender?.id !== chrome.runtime.id || !sender?.url?.startsWith(chrome.runtime.getURL(''))) {
        throw new Error('Проверка ключа доступна только из настроек');
      }
      return await validateKey(message.key);
    }
    if (message.type === 'AI_TEST_MODEL') {
      if (sender?.id !== chrome.runtime.id || !sender?.url?.startsWith(chrome.runtime.getURL(''))) {
        throw new Error('Проверка модели доступна только из настроек');
      }
      return await generateAnswer('Reply with the word OK.', message.key);
    }
    if (sender?.id !== chrome.runtime.id || typeof sender.tab?.id !== 'number') {
      throw new Error('Недопустимый источник запроса');
    }
    return await generateAnswer(String(message.text || '').trim());
  })().then(result => sendResponse({ ok: true, ...result }))
    .catch(error => {
      const errorText = safeError(error);
      console.warn('[AdBlock++] Request failed:', errorText);
      sendResponse({ ok: false, error: errorText, durationMs: Date.now() - started });
    });
  return true;
});
