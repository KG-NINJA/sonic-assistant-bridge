import { MotionBridge } from './bridge.js';

// No credentials, stored preferences, arbitrary endpoints, queue, or background replay.
export function createBridgePanel() {
  const destination = /** @type {HTMLSelectElement} */ (document.getElementById('bridge-destination'));
  const enable = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-enable'));
  const disable = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-disable'));
  const localOption = /** @type {HTMLOptionElement} */ (document.getElementById('bridge-local-option'));
  const state = document.getElementById('bridge-state');
  const delivery = document.getElementById('bridge-delivery');
  const history = document.getElementById('bridge-history');
  const preview = document.getElementById('bridge-preview');
  const localPage = location.protocol === 'http:' && location.hostname === '127.0.0.1';
  let enabled = false, previewCount = 0, failed = false;
  /** @type {AbortController | null} */
  let pending = null;
  localOption.disabled = !localPage;
  destination.value = 'preview';
  if (!localPage) document.getElementById('bridge-endpoint').textContent = '模擬受信はローカル版で利用できます。';

  function controls() {
    enable.disabled = failed || enabled || !localPage || destination.value !== 'local';
    disable.disabled = !enabled;
  }

  function disconnect() {
    enabled = false;
    pending?.abort();
    pending = null;
    try {
      if (!failed) delivery.textContent = '送信：無効 · ブラウザ内のプレビューのみ';
      controls();
    } catch { failClosed(); }
  }

  function failClosed() {
    failed = true;
    enabled = false;
    pending?.abort();
    pending = null;
    // A broken bridge must never prevent audio shutdown or existing sensor controls.
    try {
      state.textContent = 'イベント連携を停止しました · 測定の停止ボタンは利用できます';
      delivery.textContent = '連携エラー · 送信は無効です。連携を再開するにはページを再読込してください。';
      controls();
    } catch { /* Even a broken panel must leave sensor controls usable. */ }
  }

  function guard(action) {
    if (failed) return;
    try { action(); } catch { failClosed(); }
  }

  async function send(event) {
    if (failed || !enabled || !localPage || destination.value !== 'local') return;
    if (pending) {
      delivery.textContent = '模擬受信の応答待ち · 今回のイベントは送信せず、再送もしません';
      return;
    }
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 2000);
    delivery.textContent = '送信中：この PC の模擬受信先';
    try {
      const response = await fetch('/bridge/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event), credentials: 'omit', redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Receiver rejected event');
      const acknowledgement = await response.json();
      if (acknowledgement.accepted !== true || acknowledgement.eventId !== event.id || acknowledgement.delivery !== 'local-mock') {
        throw new Error('Invalid receiver acknowledgement');
      }
      if (pending === controller && enabled) {
        delivery.textContent = acknowledgement.duplicate
          ? '模擬受信で重複を抑制しました · dot 未接続'
          : '模擬受信を確認しました · dot 未接続';
      }
    } catch {
      if (pending === controller && enabled) {
        disconnect();
        delivery.textContent = '模擬受信を確認できません · 送信を無効にしました。ローカルサーバーの受信設定を確認してください。再送はしません。';
      }
    } finally {
      clearTimeout(timeout);
      if (pending === controller) pending = null;
    }
  }

  const bridge = new MotionBridge({ onEvent: event => guard(() => {
    if (previewCount++ === 0) history.replaceChildren();
    const item = document.createElement('li');
    item.textContent = `${event.occurredAt} · ${event.mode === 'synthetic' ? '[模擬]' : '[実測]'} ${event.type} · ${event.state}`;
    history.prepend(item);
    while (history.children.length > 12) history.lastChild.remove();
    preview.textContent = JSON.stringify(event, null, 2);
    void send(event).catch(failClosed);
  }) });

  destination.addEventListener('change', disconnect);
  enable.addEventListener('click', () => {
    if (failed || !localPage || destination.value !== 'local' || document.hidden) return;
    enabled = true;
    delivery.textContent = '送信：有効 · 次のイベントから模擬受信先へ送ります';
    controls();
  });
  disable.addEventListener('click', disconnect);
  controls();

  return {
    /** @param {import('./bridge.js').BridgeMode} mode */
    begin(mode) {
      guard(() => {
        state.textContent = mode === 'synthetic' ? 'イベント：模擬信号を処理中' : 'イベント：実測を開始中';
        bridge.begin(mode);
      });
    },
    /** @param {import('./dsp.js').DetectionResult} frame */
    ingest(frame) { guard(() => bridge.ingest(frame)); },
    /** @param {import('./bridge.js').StopReason} reason */
    end(reason = 'manual') {
      try {
        bridge.end(reason);
        if (!failed) state.textContent = 'イベント：停止中';
      } catch { failClosed(); }
    },
    disconnect,
  };
}
