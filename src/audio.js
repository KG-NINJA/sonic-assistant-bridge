import { Spectrum, DopplerDetector, FFT_SIZE, pilotIsUsable } from './dsp.js';

/** @typedef {{context?: AudioContext, detector?: DopplerDetector, stream?: MediaStream, source?: MediaStreamAudioSourceNode, analyser?: AnalyserNode, mute?: GainNode, osc?: OscillatorNode, gain?: GainNode, samples?: Float32Array<ArrayBuffer>, fft?: Spectrum, started?: number, phase?: string, levels?: number[], last?: number, offDb?: number, timer?: ReturnType<typeof setInterval>}} AudioSession */

// Own each session's resources. A cancelled permission request cannot restart the tone.
export class AudioSensor {
  /**
   * @param {(result: import('./dsp.js').DetectionResult, power?: Float64Array, detector?: DopplerDetector) => void} onFrame
   * @param {(error: Error) => void} onError
   * @param {{AudioContext?: typeof AudioContext, mediaDevices?: Pick<MediaDevices, 'getUserMedia'>}} environment
   */
  constructor(onFrame, onError, environment = {}) {
    this.onFrame = onFrame;
    this.onError = onError;
    this.env = environment;
    /** @type {AudioSession | null} */
    this.session = null;
  }
  stop() {
    const s = this.session;
    this.session = null;
    if (!s) return;
    clearInterval(s.timer);
    if (s.gain) { s.gain.gain.cancelScheduledValues(0); s.gain.gain.value = 0; }
    try { s.osc?.stop(); } catch { /* oscillator may not have started */ }
    s.stream?.getTracks().forEach(t => t.stop());
    s.source?.disconnect(); s.analyser?.disconnect(); s.mute?.disconnect(); s.osc?.disconnect(); s.gain?.disconnect();
    if (s.context && s.context.state !== 'closed') void s.context.close().catch(() => {});
  }
  /** @param {{frequency: number, volume: number, threshold: number, deviceId?: string}} options */
  async start({ frequency, volume, threshold, deviceId = '' }) {
    this.stop();
    /** @type {AudioSession} */
    const s = {};
    this.session = s;
    const current = () => this.session === s;
    try {
      if (!Number.isFinite(volume) || volume < 0.001 || volume > 0.03) throw new Error('送信レベルは3%以下にしてください。感度は受信側で調整します。');
      const Context = this.env.AudioContext || globalThis.AudioContext;
      const media = this.env.mediaDevices || globalThis.navigator?.mediaDevices;
      if (!Context || !media?.getUserMedia) throw new Error('Chrome / Edge で HTTPS または localhost のページを開いてください。');
      s.context = new Context({ sampleRate: 48000, latencyHint: 'interactive' });
      const resume = s.context.resume();
      // Handle rejection immediately even if the permission prompt remains open.
      resume.catch(() => {});
      s.detector = new DopplerDetector({ sampleRate: s.context.sampleRate, frequency, threshold });
      const stream = await media.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          channelCount: 1, sampleRate: 48000 }, video: false,
      });
      if (!current()) { stream.getTracks().forEach(t => t.stop()); return; }
      s.stream = stream;
      await resume;
      if (!current()) return;
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') throw new Error('マイクから音声を取得できません。');
      const settings = track.getSettings();
      if (settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl)
        throw new Error('マイクの音声補正が有効です。補正を無効化できる入力機器を選んでください。');
      track.addEventListener('ended', () => { if (current()) fail(new Error('マイクが切断されました。')); });
      track.addEventListener('mute', () => { if (current()) fail(new Error('マイク入力が一時停止しました。再開後に測定を開始してください。')); });
      s.context.onstatechange = () => {
        if (current() && s.context.state !== 'running') fail(new Error('音声処理が停止しました。測定を再開してください。'));
      };
      s.source = s.context.createMediaStreamSource(stream);
      s.analyser = s.context.createAnalyser();
      s.analyser.fftSize = FFT_SIZE;
      s.mute = s.context.createGain(); s.mute.gain.value = 0;
      s.source.connect(s.analyser); s.analyser.connect(s.mute); s.mute.connect(s.context.destination);
      s.osc = s.context.createOscillator(); s.osc.frequency.value = frequency;
      s.gain = s.context.createGain(); s.gain.gain.value = 0;
      s.osc.connect(s.gain); s.gain.connect(s.context.destination); s.osc.start();
      s.samples = new Float32Array(FFT_SIZE); s.fft = new Spectrum();
      s.started = s.context.currentTime; s.phase = 'off'; s.levels = []; s.last = s.started;
      const medianLevel = values => {
        const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
      };
      const tick = () => {
        if (!current()) return;
        try {
          const now = s.context.currentTime, elapsed = now - s.started;
          if (now - s.last > 0.75) throw new Error('解析が遅延しました。画面を前面にして再開してください。');
          if (now - s.last < 0.025) return;
          s.last = now;
          if ((s.phase === 'off' || s.phase === 'on') && elapsed > 8)
            throw new Error('物音が続いて送信音を確認できません。少し落ち着いてから再度開始してください。');
          if (s.phase === 'calibrate' && elapsed > 20)
            throw new Error('20秒間、校正に必要な安定区間を集められませんでした。PC周辺の動きや高周波の妨害を減らして再度開始してください。');
          s.analyser.getFloatTimeDomainData(s.samples);
          const { power, clipped } = s.fft.transform(s.samples);
          if (clipped && s.phase === 'monitor') throw new Error('入力が音割れしています。マイク音量または送信レベルを下げてください。');
          if (clipped && (s.phase === 'off' || s.phase === 'on')) {
            this.onFrame({ state: 'PROBE_NOISE', score: 0, progress: 0 });
            return;
          }
          const pilotDb = s.detector.pilotLevel(power);
          if (s.phase === 'off') {
            if (elapsed > 0.4) s.levels.push(pilotDb);
            this.onFrame({ state: 'PROBE_OFF', progress: elapsed / 1.6, pilotDb, score: 0 }, power, s.detector);
            if (elapsed >= 1.6 && s.levels.length >= 10) {
              s.offDb = medianLevel(s.levels); s.levels = []; s.phase = 'on'; s.started = now;
              s.gain.gain.setTargetAtTime(volume, now, 0.08);
            }
          } else if (s.phase === 'on') {
            if (elapsed > 0.5) s.levels.push(pilotDb);
            this.onFrame({ state: 'PROBE_ON', progress: elapsed / 1.8, pilotDb, pilotRiseDb: pilotDb - s.offDb, score: 0 }, power, s.detector);
            if (elapsed >= 1.8 && s.levels.length >= 10) {
              if (!pilotIsUsable(s.offDb, medianLevel(s.levels))) throw new Error(`送信音を確認できません（中央値受信 ${medianLevel(s.levels).toFixed(1)} dBFS / 発音前後差 ${(medianLevel(s.levels) - s.offDb).toFixed(1)} dB）。必要条件は受信−75 dBFS以上・差10 dB以上です。スピーカー出力先・マイクを確認してください。`);
              s.phase = 'calibrate'; s.started = now;
            }
          } else {
            const result = s.detector.process(power, now, clipped);
            if (['NO_SIGNAL', 'SIGNAL_CHANGED', 'INVALID'].includes(result.state))
              throw new Error('受信状態が変わりました。スピーカー・マイクの位置と音量を確認して再校正してください。');
            if (result.calibrated) s.phase = 'monitor';
            this.onFrame(result, power, s.detector);
          }
        } catch (error) { fail(error); }
      };
      const fail = error => { if (current()) { this.stop(); this.onError(error); } };
      s.timer = setInterval(tick, 50);
      this.onFrame({ state: 'PROBE_OFF', score: 0, progress: 0, sampleRate: s.context.sampleRate });
    } catch (error) {
      if (current()) { this.stop(); this.onError(error); }
    }
  }
}
