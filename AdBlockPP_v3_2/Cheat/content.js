(() => {
  'use strict';
  if (globalThis.__adblockppHelperReady) return;
  globalThis.__adblockppHelperReady = true;

  // Countdown begins when the answer (or an error) is received, not at keypress.
  const VISIBLE_MS = 15000;
  const LOG_LIMIT = 35;
  const logs = [];
  const stageTimers = [];
  let host = null;
  let answerNode = null;
  let logNode = null;
  let statusNode = null;
  let expires = null;
  let lastText = '';
  let lastAnswer = '';
  let pending = null;
  let sequence = 0;

  // Isolated from the site's CSS; no stylesheet needs to be added to the page.
  const stylesheet = `
    :host {
      all: initial !important; position: fixed !important; inset: 0 !important;
      z-index: 2147483646 !important; pointer-events: none !important;
    }
    * { box-sizing: border-box; }
    .hotspot {
      position: fixed; bottom: 10px; width: 26px; height: 26px;
      pointer-events: auto; background: transparent; outline: none;
    }
    .hotspot.right { right: 10px; }
    .hotspot.left { left: 10px; }
    .panel {
      position: absolute; bottom: 0; max-height: min(42vh, 320px);
      width: min(380px, calc(100vw - 28px));
      padding: 8px 10px; border-radius: 7px;
      overflow: auto; scrollbar-width: thin;
      background: rgba(24, 26, 31, 0);
      border: 1px solid transparent;
      color: rgba(238, 239, 243, .60);
      text-shadow: 0 1px 2px rgba(0, 0, 0, .45);
      font: 400 13px/1.55 Arial, sans-serif;
      white-space: pre-wrap; overflow-wrap: anywhere;
      box-shadow: none; user-select: text;
      transition: opacity .10s ease, background-color .10s ease;
    }
    .right .panel {
      right: 0;
      /* Faint answer appears immediately; hover raises its opacity. */
      opacity: .43;
      visibility: visible;
      pointer-events: auto;
    }
    .right:hover .panel, .right:focus-within .panel {
      opacity: 1;
      background: rgba(24, 26, 31, .16);
    }
    /* After 15 seconds fully hide; allow reopening by hovering again. */
    :host(.expired) .right .panel { opacity: 0; background: transparent; }
    :host(.expired) .right:hover .panel,
    :host(.expired) .right:focus-within .panel {
      opacity: 1; background: rgba(24, 26, 31, .16);
    }
    /* If the cursor was already over the answer when time expired,
       require it to leave and re-enter before revealing again. */
    :host(.expired.await-reenter) .right .panel { opacity: 0 !important; }
    :host(.expired) .indicator { opacity: 0; }
    .left .panel {
      left: 0; width: min(380px, calc(100vw - 28px));
      font: 400 11px/1.55 ui-monospace, Consolas, monospace;
      color: rgba(205, 208, 215, .78);
      opacity: 0; visibility: hidden; pointer-events: none;
    }
    .left:hover .panel, .left:focus-within .panel {
      opacity: .95; visibility: visible; pointer-events: auto;
      background: rgba(24, 26, 31, .37);
    }
    .hotspot:focus-visible { outline: 1px solid rgba(194, 199, 212, .35); }
    .indicator {
      position: fixed; top: 5px; right: 9px;
      font: 400 8px/1 ui-monospace, Consolas, monospace;
      letter-spacing: 0; color: rgba(230, 233, 239, .32);
      text-shadow: 0 1px 1px rgba(0, 0, 0, .22);
      user-select: none; pointer-events: none;
      opacity: .45;
    }
    @media (prefers-reduced-motion: reduce) { .panel { transition: none; } }
  `;

  function ensureUi() {
    if (host?.isConnected) return;
    host = document.createElement('div');
    host.id = 'page-helper-overlay-root';
    const shadow = host.attachShadow({ mode: 'open' });
    if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet !== 'undefined') {
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(stylesheet);
        shadow.adoptedStyleSheets = [sheet];
      } catch (_) {
        const style = document.createElement('style');
        style.textContent = stylesheet;
        shadow.append(style);
      }
    } else {
      const style = document.createElement('style');
      style.textContent = stylesheet;
      shadow.append(style);
    }
    const makeSpot = (side, label) => {
      const spot = document.createElement('div');
      spot.className = `hotspot ${side}`;
      spot.setAttribute('tabindex', '0');
      spot.setAttribute('aria-label', label);
      if (side === 'right') {
        spot.addEventListener('pointerleave', () => host?.classList.remove('await-reenter'));
      }
      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.setAttribute('role', 'status');
      spot.append(panel);
      shadow.append(spot);
      return panel;
    };
    logNode = makeSpot('left', 'Журнал обработки');
    answerNode = makeSpot('right', 'Ответ');
    statusNode = document.createElement('span');
    statusNode.className = 'indicator';
    statusNode.setAttribute('role', 'status');
    statusNode.setAttribute('aria-live', 'polite');
    shadow.append(statusNode);
    (document.documentElement || document.body).appendChild(host);
  }

  const stages = {
    started:    { symbol: '·', label: 'Запрос принят' },
    preparing:  { symbol: '∙', label: 'Подготовка текста' },
    sending:    { symbol: '↗', label: 'Запрос отправлен' },
    thinking:   { symbol: '⋯', label: 'ИИ обрабатывает запрос' },
    waiting:    { symbol: '⌛', label: 'Ожидание ответа провайдера' },
    cached:     { symbol: '↺', label: 'Использован сохранённый ответ' },
    received:   { symbol: '✓', label: 'Ответ получен' },
    displayed:  { symbol: '◦', label: 'Ответ доступен в правом нижнем углу' },
    copying:    { symbol: '⇢', label: 'Копирование в буфер' },
    copied:     { symbol: '⧉', label: 'Ответ скопирован' },
    error:      { symbol: '!', label: 'Ошибка, подробности в левом нижнем углу' }
  };

  function setStage(name) {
    ensureUi();
    const stage = stages[name] || stages.started;
    statusNode.textContent = stage.symbol;
    statusNode.setAttribute('aria-label', stage.label);
    statusNode.title = stage.label;
  }

  function clearStageTimers() {
    while (stageTimers.length) clearTimeout(stageTimers.pop());
  }

  function log(event) {
    const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
    logs.push(`[${time}] ${event}`);
    if (logs.length > LOG_LIMIT) logs.shift();
    ensureUi();
    logNode.textContent = logs.join('\n');
  }

  function showAnswer(message) {
    ensureUi();
    answerNode.textContent = String(message || '');
  }

  function stopExpiry() {
    if (expires != null) clearTimeout(expires);
    expires = null;
  }

  function clearView() {
    stopExpiry();
    clearStageTimers();
    host?.remove();
    host = null;
    answerNode = null;
    logNode = null;
    statusNode = null;
    logs.length = 0;
    lastText = '';
    lastAnswer = '';
    // Clipboard contents are deliberately preserved.
  }

  function expireAfterResponse(action) {
    stopExpiry();
    expires = setTimeout(() => {
      expires = null;
      if (action === 'copy') {
        clearView();
        return;
      }
      if (!host?.isConnected) return;
      const answerSpot = host.shadowRoot?.querySelector('.hotspot.right');
      if (answerSpot?.matches(':hover')) host.classList.add('await-reenter');
      host.classList.add('expired');
    }, VISIBLE_MS);
  }

  function selectedText() {
    const active = document.activeElement;
    if (active && (active.tagName === 'TEXTAREA' ||
        (active.tagName === 'INPUT' && /^(text|search|url|email|tel|password)$/i.test(active.type)))) {
      try {
        const text = active.value.slice(active.selectionStart, active.selectionEnd).trim();
        if (text) return text;
      } catch (_) { /* Unsupported selection type. */ }
    }
    return String(window.getSelection()?.toString() || '').trim();
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch (_) { /* Use execCommand as a compatibility fallback. */ }
    const field = document.createElement('textarea');
    const previousFocus = document.activeElement;
    const selection = window.getSelection();
    const savedRanges = [];
    if (selection) {
      for (let i = 0; i < selection.rangeCount; i++) {
        savedRanges.push(selection.getRangeAt(i).cloneRange());
      }
    }
    field.value = text;
    field.readOnly = true;
    field.setAttribute('aria-hidden', 'true');
    field.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
    (document.body || document.documentElement).appendChild(field);
    try {
      field.focus({ preventScroll: true });
      field.select();
      if (!document.execCommand('copy')) throw new Error('Браузер запретил копирование в буфер обмена');
    } finally {
      field.remove();
      selection?.removeAllRanges();
      savedRanges.forEach(range => selection?.addRange(range));
      try { previousFocus?.focus?.({ preventScroll: true }); } catch (_) {}
    }
  }

  async function getAnswer(text) {
    if (!text) {
      if (lastAnswer) {
        setStage('cached');
        log('Последний ответ взят из памяти (без запроса).');
        return lastAnswer;
      }
      throw new Error('Сначала выделите текст, затем нажмите Alt+X или Alt+Z.');
    }
    if (text === lastText && lastAnswer) {
      setStage('cached');
      log('Результат взят из кэша (без запроса).');
      return lastAnswer;
    }
    if (pending?.text === text) {
      log('Ожидается уже отправленный запрос.');
      return pending.promise;
    }
    setStage('sending');
    log(`Отправлено в OpenRouter (${text.length} символов).`);
    // Status changes run in parallel with the request; they never slow it down.
    stageTimers.push(setTimeout(() => setStage('thinking'), 200));
    stageTimers.push(setTimeout(() => setStage('waiting'), 3500));
    const promise = chrome.runtime.sendMessage({ type: 'AI_GENERATE', text })
      .then(result => {
        if (!result?.ok) throw new Error(result?.error || 'OpenRouter не вернул ответ');
        if (!result.answer) throw new Error('Пустой ответ API');
        lastText = text;
        lastAnswer = result.answer;
        log(`Ответ получен: ${result.model || 'Nemotron'}; ${result.durationMs ?? '?'} мс.`);
        return result.answer;
      })
      .finally(() => { if (pending?.promise === promise) pending = null; });
    pending = { text, promise };
    return promise;
  }

  async function performAction(action, forcedText = '') {
    const current = ++sequence;
    stopExpiry();
    clearStageTimers();
    ensureUi();
    host.classList.remove('expired', 'await-reenter');
    setStage('started');
    // Alt+Z shows a faint placeholder immediately; the actual answer needs API time.
    showAnswer(action === 'show' ? 'Обработка…' : '');
    log(action === 'copy' ? 'Alt+X: копирование.' : 'Alt+Z: отображение.');
    try {
      const text = String(forcedText || '').trim() || selectedText();
      setStage('preparing');
      const answer = await getAnswer(text);
      if (current !== sequence) return;
      clearStageTimers();
      setStage('received');
      if (action === 'copy') {
        setStage('copying');
        await copyToClipboard(answer);
        if (current !== sequence) return;
        setStage('copied');
        log('Успешно скопировано в буфер обмена.');
      } else {
        showAnswer(answer);
        setStage('displayed');
        log('Ответ показан бледным текстом; при наведении становится ярче.');
      }
      log('Через 15 секунд ответ станет прозрачным; его можно снова открыть наведением.');
      expireAfterResponse(action);
    } catch (error) {
      if (current !== sequence) return;
      clearStageTimers();
      const errorText = String(error?.message || error || 'Неизвестная ошибка')
        .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[API-KEY]').slice(0, 300);
      setStage('error');
      log(`Ошибка: ${errorText}`);
      showAnswer(`Ошибка: ${errorText}`);
      expireAfterResponse(action);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'AI_ACTION') return false;
    if (!['copy', 'show'].includes(message.action)) {
      sendResponse({ accepted: false, error: 'Неизвестное действие' });
      return false;
    }
    void performAction(message.action, message.selectedText || '');
    sendResponse({ accepted: true });
    return false;
  });
})();
