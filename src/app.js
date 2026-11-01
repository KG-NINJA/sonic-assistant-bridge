import { AudioSensor } from './audio.js';
import { createBridgePanel } from './bridge-ui.js';
import { DopplerDetector, Spectrum, FFT_SIZE } from './dsp.js';

/** @typedef {{[key: string]: HTMLElement, start: HTMLButtonElement, stop: HTMLButtonElement, demo: HTMLButtonElement, recalibrate: HTMLButtonElement, mic: HTMLSelectElement, frequency: HTMLSelectElement, threshold: HTMLSelectElement, volume: HTMLInputElement, 'demo-motion': HTMLSelectElement, 'volume-value': HTMLOutputElement, progress: HTMLProgressElement, spectrum: HTMLCanvasElement}} Elements */
/** @type {<K extends keyof Elements & string>(id: K) => Elements[K]} */
const $ = id => /** @type {Elements[typeof id]} */ (document.getElementById(id));
const bridge = createBridgePanel();
let mode = 'standby', sessionCount = 0, demoTimer, field;
let result = { state: 'STOPPED', score: 0 }, spectrumData = null, spectrumDetector = null;
const stateLabels = {
  STOPPED: ['待機中', 'READY TO SENSE', '測定を開始すると、周囲の動きを解析します。'],
  STARTING: ['マイクを準備中', 'CONNECTING', 'ブラウザのマイク使用許可を確認してください。'],
  PROBE_OFF: ['環境音を確認中', 'CHECK 1 / 3', '発音前の高周波ノイズを測定しています。'],
  PROBE_ON: ['送信音を確認中', 'CHECK 2 / 3', 'スピーカーからの高周波音をマイクで確認しています。'],
  PROBE_NOISE: ['物音の区間を除外中', 'CHECK AUDIO', '一時的な音割れを除外し、送信音の確認を続けています。'],
  CALIBRATING: ['周囲を校正中', 'CHECK 3 / 3', '会話や一時的な物音は許容します。PCの位置を固定してお待ちください。'],
  CALIBRATION_NOISE: ['物音を除外して校正中', 'CHECK 3 / 3', '雑音の区間を除外し、自動で安定した区間を追加しています。'],
  CALM: ['動きなし', 'FIELD STABLE', '検知できる動きはありません。在席・不在を示すものではありません。'],
  APPROACH: ['接近する動きを検知', '→ APPROACH', '赤い波がPCへ向かって収束します。'],
  RECEDE: ['離れる動きを検知', '← RECEDE', '青い波がPCから外側へ広がります。'],
  MOTION: ['周囲に動きを検知', '↔ MOTION', '接近・離反が混在しているか、方向を判定できません。'],
  ERROR: ['測定できません', 'CHECK AUDIO', '入力・出力機器を確認して、再度開始してください。'],
};
function setMode(value) {
  mode = value; document.body.dataset.mode = value;
  $('mode').textContent = value === 'live' ? 'LIVE · 実測' : value === 'demo' ? 'DEMO · 模擬信号' : 'STANDBY · 待機';
  $('start').disabled = value === 'live'; $('demo').disabled = value === 'demo';
  $('stop').disabled = value === 'standby'; $('recalibrate').disabled = value !== 'live';
  for (const id of /** @type {const} */ (['mic', 'frequency', 'threshold', 'volume'])) $(id).disabled = value !== 'standby';
  if (value !== 'standby') $('count-label').textContent = value === 'demo' ? 'デモ内のイベント' : '今回の測定';
}
function resetEvents() {
  sessionCount = 0; $('count').textContent = '0'; $('events').replaceChildren();
  const li = document.createElement('li'); li.textContent = '検知イベントはまだありません'; $('events').append(li);
}
function render(value, power, detector) {
  bridge.ingest(value);
  result = value;
  document.body.dataset.state = value.state;
  const captureState = mode === 'demo' ? 'デモ稼働中 · マイク入力・発音なし'
    : mode !== 'live' ? 'マイク：停止 · 発音：停止'
    : value.state === 'STARTING' ? '実測の準備中 · マイクの許可を確認中 · 発音前'
    : value.state === 'PROBE_OFF' ? '実測稼働中 · マイク使用中 · 発音前'
    : value.state === 'PROBE_NOISE' ? '実測稼働中 · マイク使用中 · 発音を確認中'
    : '実測稼働中 · マイク使用中 · 高周波音を出力中';
  if ($('capture-state').textContent !== captureState) $('capture-state').textContent = captureState;
  const labels = value.state === 'APPROACH' && value.reason === 'occlusion'
    ? ['接近・遮蔽を検知', '→ APPROACH / BLOCKED', '送信音の低下を接近として検知しています。音量低下・消音でも反応します。']
    : stateLabels[value.state] || [value.state, '', ''];
  $('score-unit').textContent = value.dropDb !== undefined ? 'dB / 送信音の低下' : 'dB / 校正基準超過';
  $('status').textContent = labels[0]; $('direction').textContent = labels[1]; $('hint').textContent = labels[2];
  $('score').textContent = Number.isFinite(value.score) && !['STOPPED', 'ERROR', 'STARTING'].includes(value.state) ? value.score.toFixed(1) : '—';
  $('pilot').textContent = Number.isFinite(value.pilotDb) ? value.pilotDb.toFixed(1) : '—';
  $('progress').value = value.progress ?? (['CALM', 'APPROACH', 'RECEDE', 'MOTION'].includes(value.state) ? 1 : 0);
  if (mode === 'live' && Number.isFinite(value.pilotDb)) {
    $('diagnostic').textContent = value.state === 'PROBE_OFF' ? `受信診断：発音前 ${value.pilotDb.toFixed(1)} dBFS` :
      value.state === 'PROBE_ON' ? `受信診断（瞬時）：${value.pilotDb.toFixed(1)} dBFS / 上昇 ${value.pilotRiseDb?.toFixed(1) ?? '—'} dB（必要：受信−75 dBFS以上・上昇10 dB以上）` :
      `受信診断：送信音確認済み / ${value.pilotDb.toFixed(1)} dBFS / ${['CALIBRATING', 'CALIBRATION_NOISE'].includes(value.state) ? '校正中' : '校正完了'}`;
  }
  if (value.calibrated) $('message').textContent = '校正完了。画面を前面にしたまま、PCに近づいて反応を確認してください。';
  else if (['PROBE_OFF', 'PROBE_ON', 'PROBE_NOISE', 'CALIBRATING', 'CALIBRATION_NOISE'].includes(value.state)) $('message').textContent = labels[2];
  if (value.event) {
    sessionCount++; $('count').textContent = String(sessionCount);
    if (sessionCount === 1) $('events').replaceChildren();
    const item = document.createElement('li');
    item.textContent = `${new Date().toLocaleTimeString('ja-JP')} · ${mode === 'demo' ? '[デモ] ' : ''}${value.reason === 'occlusion' ? '接近・遮蔽（受信低下）' : value.state === 'APPROACH' ? '接近する動き' : value.state === 'RECEDE' ? '離れる動き' : '動き（方向不明）'} · ${value.score.toFixed(1)} dB`;
    $('events').prepend(item);
    while ($('events').children.length > 12) $('events').lastChild.remove();
  }
  spectrumData = power ? Float64Array.from(power) : null; spectrumDetector = detector;
  if (detector) $('resolution').textContent = `${detector.sampleRate / 1000} kHz / Δf ${detector.binHz.toFixed(2)} Hz`;
  field?.update(value); drawSpectrum();
}
/** @param {string} [message] @param {import('./bridge.js').StopReason} [reason] */
function stop(message = '停止しました。発音とマイク入力を終了しています。', reason = 'manual') {
  clearInterval(demoTimer); demoTimer = null; sensor.stop(); bridge.end(reason);
  setMode('standby'); render({ state: 'STOPPED', score: 0 }); $('message').textContent = message;
}
const sensor = new AudioSensor(render, error => {
  bridge.disconnect(); stop(undefined, 'sensor_error'); render({ state: 'ERROR', score: 0 });
  const messages = {
    NotAllowedError: 'マイクの使用が許可されていません。ブラウザのサイト設定を確認してください。',
    NotFoundError: 'マイクが見つかりません。入力機器を接続してください。',
    NotReadableError: 'マイクを開始できませんでした。他のアプリの使用状況や機器の接続を確認して、再度開始してください。',
    AbortError: 'マイクを開始できませんでした。他のアプリの使用状況や機器の接続を確認して、再度開始してください。',
    SecurityError: 'このページではマイクを利用できません。HTTPS または localhost で開き、ブラウザの対応状況を確認してください。',
  };
  $('message').textContent = messages[error.name] || error.message;
});
async function start() {
  stop(undefined, 'restart'); resetEvents(); bridge.begin('live'); setMode('live'); render({ state: 'STARTING', score: 0 });
  $('message').textContent = '通常約8秒。物音が入ると自動延長します。PCを固定してお待ちください。';
  $('diagnostic').textContent = '受信診断：マイクの準備中';
  await sensor.start({ frequency: Number($('frequency').value), volume: Number($('volume').value) / 100, threshold: Number($('threshold').value), deviceId: $('mic').value });
  if (mode === 'live') void updateDevices();
}
async function updateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const selected = $('mic').value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId);
    $('mic').replaceChildren(new Option('システム既定のマイク', ''));
    devices.forEach((d, i) => $('mic').add(new Option(d.label || `マイク ${i + 1}`, d.deviceId)));
    if (devices.some(d => d.deviceId === selected)) $('mic').value = selected;
  } catch { /* Keep the usable default; startup reports actual device failures. */ }
}
function startDemo() {
  stop(undefined, 'restart'); resetEvents(); bridge.begin('synthetic'); setMode('demo');
  $('message').textContent = '模擬音声を同じ解析器に入力しています。実際の接近検知ではありません。';
  $('diagnostic').textContent = 'デモ：実機の受信診断は行いません';
  const detector = new DopplerDetector({ calibrationFrames: 10, frequency: Number($('frequency').value), threshold: Number($('threshold').value) });
  const fft = new Spectrum(), samples = new Float32Array(FFT_SIZE);
  let frame = 0;
  function tick() {
    const t = frame * 0.05;
    const selected = $('demo-motion').value;
    const kind = frame < 12 ? 'CALM' : selected === 'cycle' ? ['CALM', 'APPROACH', 'CALM', 'RECEDE', 'MOTION'][Math.floor(t / 4) % 5] : selected;
    for (let i = 0; i < samples.length; i++) {
      const phase = (i + frame * 2400) / 48000 * 2 * Math.PI;
      samples[i] = (kind === 'OCCLUSION' ? 0.008 : 0.08) * Math.sin(detector.frequency * phase) + 0.00001 * Math.sin(3713 * phase);
      if (kind === 'WEAK') samples[i] += 0.0001 * Math.sin((detector.frequency + 35) * phase);
      if (kind === 'APPROACH' || kind === 'MOTION') samples[i] += 0.004 * Math.sin((detector.frequency + 140) * phase);
      if (kind === 'RECEDE' || kind === 'MOTION') samples[i] += 0.004 * Math.sin((detector.frequency - 140) * phase);
    }
    const { power } = fft.transform(samples);
    const value = detector.process(power, t);
    render(value, power, detector);
    $('message').textContent = 'デモ：模擬音声を解析しています。マイク入力・スピーカー出力は使用していません。';
    frame++;
  }
  tick(); demoTimer = setInterval(tick, 50);
}
function drawSpectrum() {
  const canvas = $('spectrum'), rect = canvas.getBoundingClientRect(), scale = Math.min(devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * scale)); canvas.height = Math.floor(rect.height * scale);
  const ctx = canvas.getContext('2d'); ctx.scale(scale, scale);
  const w = rect.width, h = rect.height;
  ctx.strokeStyle = '#223645'; ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(0, i * h / 4); ctx.lineTo(w, i * h / 4); ctx.stroke(); }
  const guard = spectrumDetector?.guardHz ?? (Number($('threshold').value) <= 3 ? 18 : 35);
  ctx.fillStyle = '#152e37'; ctx.fillRect(w * (0.5 - guard / 900), 0, w * 2 * guard / 900, h);
  if (!spectrumData || !spectrumDetector) return;
  const d = spectrumDetector;
  const begin = Math.ceil((d.frequency - 450) / d.binHz), end = Math.floor((d.frequency + 450) / d.binHz);
  for (let i = begin; i <= end; i++) {
    const offset = i * d.binHz - d.frequency;
    const x = (offset + 450) / 900 * w;
    const level = 10 * Math.log10(Math.max(1e-15, spectrumData[i]));
    const size = Math.max(1, Math.min(h, (level + 110) / 100 * h));
    ctx.fillStyle = Math.abs(offset) < guard ? '#74edcc' : offset > 0 ? '#ff776d' : '#75b6ff';
    ctx.fillRect(x, h - size, Math.max(1, w * d.binHz / 900 - 1), size);
  }
}
$('start').addEventListener('click', start); $('recalibrate').addEventListener('click', start);
$('stop').addEventListener('click', () => stop()); $('demo').addEventListener('click', startDemo);
$('volume').addEventListener('input', () => { $('volume-value').value = `${$('volume').value}%`; });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  bridge.disconnect();
  if (mode !== 'standby') stop('画面が非表示になったため停止しました。再度開始してください。', 'page_hidden');
});
window.addEventListener('pagehide', () => { bridge.disconnect(); stop(undefined, 'pagehide'); });
navigator.mediaDevices?.addEventListener('devicechange', () => { if (mode === 'live') { bridge.disconnect(); stop('音声機器が変更されたため停止しました。再度開始してください。', 'device_change'); } void updateDevices(); });
window.addEventListener('resize', drawSpectrum);
render(result); void updateDevices();
// A WebGL failure must not disable audio controls or the spectrum display.
import('./scene.js').then(({ createField }) => { field = createField($('scene')); field.update(result); }).catch(() => { $('engine').textContent = '3D非対応 · 数値とスペクトルで表示'; });
