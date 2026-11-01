import { MotionBridge } from './bridge.js';

// Destinations are fixed same-origin paths. Credentials are browser-managed;
// there are no tokens, stored opt-ins, arbitrary endpoints, or background replay.
export function createBridgePanel() {
  const destination = /** @type {HTMLSelectElement} */ (document.getElementById('bridge-destination'));
  const enable = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-enable'));
  const disable = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-disable'));
  const check = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-check'));
  const unsubscribe = /** @type {HTMLButtonElement} */ (document.getElementById('bridge-unsubscribe'));
  const localOption = /** @type {HTMLOptionElement} */ (document.getElementById('bridge-local-option'));
  const privateOption = /** @type {HTMLOptionElement} */ (document.getElementById('bridge-private-option'));
  const state = document.getElementById('bridge-state');
  const delivery = document.getElementById('bridge-delivery');
  const privateStatus = document.getElementById('bridge-private-status');
  const connection = document.getElementById('bridge-connection');
  const history = document.getElementById('bridge-history');
  const preview = document.getElementById('bridge-preview');
  const loopback = location.protocol === 'http:' && location.hostname === '127.0.0.1';
  // Neither marker appears in public HTML. The second marker is injected only by
  // the loopback browser-test fixture. Neither marker grants server authorization.
  const privateSite = document.body.dataset.privateBridge === 'true' &&
    (location.protocol === 'https:' || (loopback && document.body.dataset.privateBridgeTest === 'true'));
  const localPage = loopback && !privateSite;
  let enabled = false, previewCount = 0, failed = false;
  let authenticated = false, subscriptionActive = false, privateReady = false;
  /** @type {AbortController | null} */
  let pending = null;
  let pendingKind = '';
  localOption.disabled = !localPage;
  privateOption.disabled = !privateSite;
  privateOption.hidden = !privateSite;
  document.getElementById('bridge-private-controls').hidden = !privateSite;
  destination.value = 'preview';
  if (privateSite) {
    document.getElementById('bridge-availability').textContent = '非公開サイト：送信先を選び、認証と購読を確認してから送信を有効にしてください。';
    document.getElementById('bridge-endpoint').textContent = '送信先はこのサイトの /api/bridge/events です。認証はブラウザのセッションを使い、秘密はサーバーだけで管理します。';
    connection.textContent = 'dot の受信：未確認';
  } else if (localPage) {
    document.getElementById('bridge-availability').textContent = 'ローカル版：模擬受信はローカルサーバーで受信を有効にした場合だけ利用できます。dot には届きません。';
    document.getElementById('bridge-endpoint').textContent = '送信先はこのページと同じローカルサーバーの /bridge/events です。外部 URL や秘密の入力は不要です。';
  }

  function canEnable() {
    return !failed && !enabled && !pending &&
      ((destination.value === 'local' && localPage) || (destination.value === 'private' && privateSite && privateReady));
  }
  function controls() {
    enable.disabled = !canEnable();
    enable.textContent = destination.value === 'private' ? '認証済み連携への送信を有効にする' : '模擬受信への送信を有効にする';
    disable.disabled = !enabled && !pending;
    check.disabled = failed || !privateSite || ['check', 'unsubscribe'].includes(pendingKind);
    unsubscribe.disabled = failed || !privateSite || !authenticated || !subscriptionActive || pendingKind === 'unsubscribe';
  }

  function cancelPending() {
    const controller = pending;
    pending = null; pendingKind = '';
    controller?.abort();
  }
  function disconnect() {
    enabled = false; privateReady = false;
    const cancelledKind = pendingKind;
    cancelPending();
    try {
      if (!failed) delivery.textContent = '送信：無効 · ブラウザ内のプレビューのみ';
      if (cancelledKind === 'check' || cancelledKind === 'unsubscribe') {
        authenticated = false; subscriptionActive = false;
        privateStatus.textContent = cancelledKind === 'unsubscribe'
          ? '購読解除を確認できません。送信は無効です。状態を再確認してください。'
          : '認証と購読：未確認';
      } else if (privateSite) {
        privateStatus.textContent = '送信を有効にするには、認証と購読を再確認してください。';
      }
      controls();
    } catch { failClosed(); }
  }
  function failClosed() {
    failed = true; enabled = false; privateReady = false;
    cancelPending();
    // Bridge faults must never prevent sensor shutdown or existing controls.
    try {
      state.textContent = 'イベント連携を停止しました · 測定の停止ボタンは利用できます';
      delivery.textContent = '連携エラー · 送信は無効です。連携を再開するにはページを再読込してください。';
      controls();
    } catch { /* Leave sensor controls usable even if the panel is broken. */ }
  }
  function guard(action) {
    if (failed) return;
    try { action(); } catch { failClosed(); }
  }
  function startRequest(kind) {
    const controller = new AbortController();
    pending = controller; pendingKind = kind; controls();
    return { controller, timeout: setTimeout(() => controller.abort(), kind === 'send' && privateSite ? 8000 : 3000) };
  }
  function finishRequest(controller, timeout) {
    clearTimeout(timeout);
    if (pending === controller) { pending = null; pendingKind = ''; controls(); }
  }

  async function checkStatus() {
    if (failed || !privateSite || document.hidden) return;
    disconnect(); authenticated = false; subscriptionActive = false;
    privateStatus.textContent = '認証と購読を確認しています。送信は無効のままです。';
    const { controller, timeout } = startRequest('check');
    try {
      const response = await fetch('/api/bridge/status', {
        credentials: 'same-origin', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Status unavailable');
      const status = await response.json();
      if (typeof status.authenticated !== 'boolean' || typeof status.subscriptionActive !== 'boolean' ||
        typeof status.deliveryReady !== 'boolean' || typeof status.testMode !== 'boolean' || status.delivery !== 'mcp-webhook') throw new Error('Invalid status');
      if (pending !== controller) return;
      authenticated = status.authenticated;
      subscriptionActive = authenticated && status.subscriptionActive;
      privateReady = authenticated && subscriptionActive && status.deliveryReady;
      privateStatus.textContent = !authenticated ? '認証を確認できません。このサイトにログインしてから再確認してください。'
        : !subscriptionActive ? '有効な購読がありません。設定ガイドを確認してください。'
        : !privateReady ? '購読はありますが、配送の準備ができていません。送信は無効です。'
        : status.testMode === true ? 'テスト用の配送準備を確認しました。実配送ではありません。'
        : '認証と配送準備を確認しました。dot の受信は未確認です。';
      connection.textContent = status.testMode === true ? '模擬配送 · dot 未接続' : 'dot の受信：未確認';
    } catch {
      if (pending === controller) {
        authenticated = false; subscriptionActive = false; privateReady = false;
        privateStatus.textContent = '認証と購読を確認できません。送信は無効です。ログイン状態と設定を確認してください。';
      }
    } finally { finishRequest(controller, timeout); }
  }

  async function unsubscribeNow() {
    if (failed || !privateSite || !authenticated || !subscriptionActive || document.hidden) return;
    disconnect();
    privateStatus.textContent = '購読を解除しています。送信は無効です。';
    const { controller, timeout } = startRequest('unsubscribe');
    try {
      const response = await fetch('/api/bridge/unsubscribe', {
        method: 'POST', body: '{}', credentials: 'same-origin', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('Unsubscribe unconfirmed');
      const result = await response.json();
      if (result.unsubscribed !== true) throw new Error('Invalid unsubscribe acknowledgement');
      if (pending !== controller) return;
      subscriptionActive = false;
      privateStatus.textContent = '購読解除を確認しました。送信は無効です。';
      connection.textContent = 'dot 未接続';
    } catch {
      if (pending === controller) {
        privateStatus.textContent = '購読解除を確認できません。送信は無効です。状態を再確認してください。';
        // A timed-out write may have completed; recheck instead of blindly retrying.
        authenticated = false; subscriptionActive = false;
      }
    } finally { finishRequest(controller, timeout); }
  }

  async function send(event) {
    const privateDelivery = destination.value === 'private' && privateSite && privateReady;
    if (failed || !enabled || (!privateDelivery && !(destination.value === 'local' && localPage))) return;
    if (pending) {
      delivery.textContent = '応答待ち · 今回のイベントは送信せず、再送もしません';
      return;
    }
    const { controller, timeout } = startRequest('send');
    delivery.textContent = privateDelivery ? '送信中：認証済みの連携先' : '送信中：この PC の模擬受信先';
    try {
      const response = await fetch(privateDelivery ? '/api/bridge/events' : '/bridge/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
        credentials: privateDelivery ? 'same-origin' : 'omit', redirect: 'error', signal: controller.signal,
      });
      if (!response.ok) throw new Error('Receiver rejected event');
      const acknowledgement = await response.json();
      if (acknowledgement.eventId !== event.id || acknowledgement.delivery !== (privateDelivery ? 'mcp-webhook' : 'local-mock')) {
        throw new Error('Invalid receiver acknowledgement');
      }
      if (privateDelivery && typeof acknowledgement.testMode !== 'boolean') throw new Error('Invalid delivery mode');
      const filtered = privateDelivery && acknowledgement.accepted === false && acknowledgement.outcome === 'filtered';
      if (!filtered && (acknowledgement.accepted !== true || (privateDelivery && acknowledgement.outcome !== 'callback-accepted'))) {
        throw new Error('Delivery not confirmed');
      }
      if (pending !== controller || !enabled) return;
      delivery.textContent = filtered ? '配送対象外のイベントです。コールバックへの送信は行っていません。'
        : privateDelivery ? acknowledgement.testMode === true
          ? 'テスト用の受信処理を確認しました · 実配送と dot の受信は未確認です'
          : 'コールバックの受理を確認しました · dot の処理・受信確認ではありません'
        : acknowledgement.duplicate ? '模擬受信で重複を抑制しました · dot 未接続' : '模擬受信を確認しました · dot 未接続';
    } catch {
      if (pending === controller && enabled) {
        disconnect();
        delivery.textContent = privateDelivery
          ? '配送結果を確認できません · 送信を無効にしました。既に配送された可能性があるため再送しません。'
          : '模擬受信を確認できません · 送信を無効にしました。ローカルサーバーの受信設定を確認してください。再送はしません。';
      }
    } finally { finishRequest(controller, timeout); }
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
  enable.addEventListener('click', () => guard(() => {
    if (!canEnable() || document.hidden) return;
    enabled = true;
    delivery.textContent = destination.value === 'private'
      ? '送信：有効 · 次のイベントから認証済み連携先へ送ります'
      : '送信：有効 · 次のイベントから模擬受信先へ送ります';
    controls();
  }));
  disable.addEventListener('click', disconnect);
  check.addEventListener('click', () => { void checkStatus().catch(failClosed); });
  unsubscribe.addEventListener('click', () => { void unsubscribeNow().catch(failClosed); });
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
