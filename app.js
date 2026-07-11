'use strict';

/* =========================================================
   SIGNAL/MIDI — 音声解析コンソール
   ブラウザ完結型 音声→MIDI再解釈エンジン
   ========================================================= */

// ---------------------------------------------------------
// モード定義（仕様書 7章）
// ---------------------------------------------------------
const MODES = [
  {
    id: 'auto',
    idx: '00',
    name: '自動判定',
    desc: '音源の特徴から最適なモードを自動選択します。'
  },
  {
    id: 'monophonic',
    idx: '01',
    name: '単音重視',
    desc: '各時間区間で最も強い1音だけを採用。声や旋律の再現向け。'
  },
  {
    id: 'vocal',
    idx: '02',
    name: '声優先',
    desc: '人の声の音域に絞って最も強い1音を採用。息継ぎ等の無音でのみ音を区切る。'
  },
  {
    id: 'rhythm',
    idx: '03',
    name: 'リズム優先',
    desc: '立ち上がりと強弱を重視。打楽器トラックへ寄せる。'
  },
  {
    id: 'noise',
    idx: '04',
    name: 'ノイズ/環境音',
    desc: '音高が不安定でも質感を残し短音イベント化。'
  },
  {
    id: 'chroma',
    idx: '05',
    name: '和音・密集音',
    desc: '検出できた周波数成分を閾値でふるいにかけず、強さに応じたベロシティですべて鳴らします。音は短く細かく刻んで再生されます。（他モードより解析に時間がかかります）'
  },
  {
    id: 'melody_chord',
    idx: '06',
    name: 'メロディ和音',
    desc: 'ベルやピアノなど倍音が豊かな音源向け。強い音から基音候補を選び、その整数倍（倍音）にあたる音階は除外して、実際に鳴らされた音階だけを和音として拾います。オクターブ違いの同時発音も別音として認識します。'
  }
];

// ---------------------------------------------------------
// アプリケーション状態
// ---------------------------------------------------------
const state = {
  audioBuffer: null,
  fileName: '',
  mode: 'auto',
  resolvedMode: null, // 自動判定後に確定するモード
  analysis: null,     // 解析結果一式
  isAnalyzing: false,
  notifyOnComplete: true, // 解析完了時にブラウザ通知するか
  playback: {
    ctx: null,
    sourceNode: null,
    gainNode: null,
    isPlaying: false,
    startedAt: 0,
    offset: 0,
    raf: null
  },
  params: {
    frameLenMs: 20,
    hopLenMs: 10,
    autoFrame: true,
    minNoteMs: 30,
    silenceThreshPercent: 15, // スライダー値、dBに変換
    velSensPercent: 70,
    pitchBend: true,
    trackMode: 'multi',
    noteMerge: 15,
    eventSens: 55,
    centerOnMelody: false,
    instrument: '0', // GM音色番号。'auto'ならモードに応じた既定音色を使う（既定: 0 = Acoustic Grand Piano）
    maxNoteLimit: 1000000 // 和音・密集音モードでのノート数上限（超えると解析を中止）
  }
};

// ---------------------------------------------------------
// DOM参照
// ---------------------------------------------------------
const $ = (id) => document.getElementById(id);

const el = {
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  fileProtocolWarning: $('fileProtocolWarning'),
  dropzone: $('dropzone'),
  fileInput: $('fileInput'),
  dropzoneEmpty: $('dropzoneEmpty'),
  dropzoneLoaded: $('dropzoneLoaded'),
  loadedFname: $('loadedFname'),
  loadedFmeta: $('loadedFmeta'),
  btnReplace: $('btnReplace'),
  modeGrid: $('modeGrid'),

  frameLen: $('frameLen'), frameLenVal: $('frameLenVal'),
  hopLen: $('hopLen'), hopLenVal: $('hopLenVal'),
  toggleAutoFrame: $('toggleAutoFrame'),
  minNote: $('minNote'), minNoteVal: $('minNoteVal'),
  silenceThresh: $('silenceThresh'), silenceThreshVal: $('silenceThreshVal'),
  velSens: $('velSens'), velSensVal: $('velSensVal'),
  togglePitchBend: $('togglePitchBend'),
  toggleCenterMelody: $('toggleCenterMelody'),
  trackMode: $('trackMode'),
  instrument: $('instrument'),
  maxNoteLimit: $('maxNoteLimit'),
  noteMerge: $('noteMerge'), noteMergeVal: $('noteMergeVal'),
  eventSens: $('eventSens'), eventSensVal: $('eventSensVal'),
  toggleNotify: $('toggleNotify'),

  btnAnalyze: $('btnAnalyze'),
  btnReanalyze: $('btnReanalyze'),
  progressWrap: $('progressWrap'),
  progressText: $('progressText'),
  progressFill: $('progressFill'),

  vizPanel: $('vizPanel'),
  metricsPanel: $('metricsPanel'),
  outputPanel: $('outputPanel'),

  cvWave: $('cvWave'),
  cvSpec: $('cvSpec'),
  cvPitch: $('cvPitch'),
  cvEvent: $('cvEvent'),

  btnPlay: $('btnPlay'),
  playTime: $('playTime'),
  playTrack: $('playTrack'),
  playProgress: $('playProgress'),

  mNotes: $('mNotes'),
  mEvents: $('mEvents'),
  mRange: $('mRange'),
  mMode: $('mMode'),

  btnDownloadMidi: $('btnDownloadMidi'),
  btnDownloadJson: $('btnDownloadJson')
};

// ---------------------------------------------------------
// ステータス表示
// ---------------------------------------------------------
function setStatus(text, live) {
  el.statusText.textContent = text;
  el.statusDot.classList.toggle('live', !!live);
}

// ---------------------------------------------------------
// モードグリッド構築
// ---------------------------------------------------------
function buildModeGrid() {
  el.modeGrid.innerHTML = '';
  MODES.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'mode-card' + (m.id === state.mode ? ' active' : '');
    card.dataset.mode = m.id;
    card.innerHTML = `
      <div class="idx">${m.idx}</div>
      <div class="name">${m.name}</div>
      <div class="desc">${m.desc}</div>
    `;
    card.addEventListener('click', () => {
      state.mode = m.id;
      buildModeGrid();
    });
    el.modeGrid.appendChild(card);
  });
}
buildModeGrid();

// ---------------------------------------------------------
// パラメータUIバインド
// ---------------------------------------------------------
function bindRange(input, label, fmt, key) {
  const update = () => {
    const v = Number(input.value);
    state.params[key] = v;
    label.textContent = fmt(v);
  };
  input.addEventListener('input', update);
  update();
}

bindRange(el.frameLen, el.frameLenVal, (v) => `${v} ms`, 'frameLenMs');
bindRange(el.hopLen, el.hopLenVal, (v) => `${v} ms`, 'hopLenMs');
bindRange(el.minNote, el.minNoteVal, (v) => `${v} ms`, 'minNoteMs');
bindRange(el.silenceThresh, el.silenceThreshVal, (v) => `${-60 + v}dB`, 'silenceThreshPercent');
bindRange(el.velSens, el.velSensVal, (v) => `${v}%`, 'velSensPercent');
bindRange(el.noteMerge, el.noteMergeVal, (v) => {
  if (v <= 15) return '最大限細かく';
  if (v <= 40) return '細かく';
  if (v <= 60) return '標準';
  if (v <= 85) return 'まとめる';
  return '最大限まとめる';
}, 'noteMerge');
bindRange(el.eventSens, el.eventSensVal, (v) => `${v}%`, 'eventSens');

function setupToggle(toggleEl, key, defaultOn) {
  let on = defaultOn;
  const apply = () => {
    toggleEl.classList.toggle('on', on);
    state.params[key] = on;
  };
  toggleEl.addEventListener('click', () => { on = !on; apply(); });
  apply();
}
setupToggle(el.toggleAutoFrame, 'autoFrame', true);
setupToggle(el.togglePitchBend, 'pitchBend', true);
setupToggle(el.toggleCenterMelody, 'centerOnMelody', false);

// 通知トグルは params ではなく state 直下のフラグを操作する。
// オンにした瞬間（ユーザー操作の直後）にブラウザの通知許可をリクエストする。
(function setupNotifyToggle() {
  let on = state.notifyOnComplete;
  const apply = () => {
    el.toggleNotify.classList.toggle('on', on);
    state.notifyOnComplete = on;
  };
  el.toggleNotify.addEventListener('click', () => {
    on = !on;
    apply();
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  });
  apply();
})();

el.trackMode.addEventListener('change', () => {
  state.params.trackMode = el.trackMode.value;
});

el.instrument.addEventListener('change', () => {
  state.params.instrument = el.instrument.value;
});

el.maxNoteLimit.addEventListener('change', () => {
  state.params.maxNoteLimit = parseInt(el.maxNoteLimit.value, 10);
});

// フレーム長/ホップ長の自動調整トグル → 手動スライダー無効化の視覚化
function refreshFrameControlAvailability() {
  const auto = state.params.autoFrame;
  el.frameLen.disabled = false; // 自動時も見た目上は操作可能（解析時に上書き通知）
}
refreshFrameControlAvailability();

// ---------------------------------------------------------
// ファイル読込
// ---------------------------------------------------------
function humanFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB'];
  let val = bytes / 1024, i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return val.toFixed(1) + ' ' + units[i];
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function loadFile(file) {
  setStatus('読込中 — ' + file.name, false);
  el.btnAnalyze.disabled = true;
  el.btnReanalyze.disabled = true;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = getAudioCtx();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

    state.audioBuffer = audioBuffer;
    state.fileName = file.name;

    el.dropzoneEmpty.classList.add('hidden');
    el.dropzoneLoaded.classList.remove('hidden');
    el.loadedFname.textContent = file.name;
    el.loadedFmeta.textContent =
      `${humanFileSize(file.size)} / ${formatTime(audioBuffer.duration)} / ` +
      `${audioBuffer.sampleRate} Hz / ${audioBuffer.numberOfChannels}ch`;

    el.btnAnalyze.disabled = false;
    setStatus('読込完了 — 解析を開始できます', true);

    // 解析済み結果があればクリア（新規ファイルのため）
    state.analysis = null;
    el.vizPanel.classList.add('hidden');
    el.metricsPanel.classList.add('hidden');
    el.outputPanel.classList.add('hidden');
  } catch (err) {
    console.error(err);
    setStatus('読込エラー — ファイル形式を確認してください', false);
    alert('音声ファイルの読込に失敗しました。対応形式かご確認ください。\n\n' + err.message);
  }
}

el.dropzone.addEventListener('click', (e) => {
  if (e.target === el.btnReplace) return;
  if (!state.audioBuffer) el.fileInput.click();
});
el.btnReplace.addEventListener('click', (e) => {
  e.stopPropagation();
  el.fileInput.click();
});
el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files && el.fileInput.files[0]) {
    loadFile(el.fileInput.files[0]);
  }
});
['dragenter', 'dragover'].forEach((evt) => {
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.add('drag');
  });
});
['dragleave', 'drop'].forEach((evt) => {
  el.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('drag');
  });
});
el.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});

// ---------------------------------------------------------
// AudioContext（共有）
// ---------------------------------------------------------
let sharedAudioCtx = null;
function getAudioCtx() {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return sharedAudioCtx;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// 和音モードの可視化・JSON出力で使う定数（analyzer-worker.js内の定義と対応させる）
const CHROMA_MIDI_MIN = 21; // A0

/* =========================================================
   解析ワーカーとの通信
   タブがバックグラウンドになっても解析が進み続けるよう、
   実際の解析処理はWeb Worker（analyzer-worker.js）上で実行する。
   ========================================================= */

let analyzerWorker = null;
let analyzerWorkerFailed = false;

function getAnalyzerWorker() {
  if (analyzerWorkerFailed) {
    throw buildWorkerUnavailableError();
  }
  if (!analyzerWorker) {
    // file:// で直接開いている場合、Workerの生成自体がブラウザの
    // セキュリティ制約でブロックされる。この場合は new Worker() が
    // 同期的に例外を投げないことがあり、代わりに非同期の 'error'
    // イベントとして失敗が通知されるブラウザもあるため、
    // 事前にプロトコルをチェックしてはっきり原因を伝える。
    if (window.location.protocol === 'file:') {
      analyzerWorkerFailed = true;
      throw buildWorkerUnavailableError();
    }
    try {
      analyzerWorker = new Worker('./analyzer-worker.js');
      analyzerWorker.addEventListener('error', () => {
        // Worker内部の読み込み自体が失敗した場合（相対パスが解決できない等）
        analyzerWorkerFailed = true;
        analyzerWorker = null;
      });
    } catch (e) {
      analyzerWorkerFailed = true;
      throw buildWorkerUnavailableError();
    }
  }
  return analyzerWorker;
}

function buildWorkerUnavailableError() {
  const isFileProtocol = window.location.protocol === 'file:';
  const reason = isFileProtocol
    ? 'このページを「ファイルをダブルクリックして開く」形（アドレス欄が file:// で始まる状態）で表示しているためです。ブラウザの仕様上、この開き方ではバックグラウンド処理（Web Worker）が使えません。'
    : 'バックグラウンド解析用のワーカーの読み込みに失敗しました。index.html と analyzer-worker.js が同じフォルダにあるか確認してください。';
  const howTo = isFileProtocol
    ? '\n\n【対処方法】ごく簡単なローカルサーバーを立ててから開いてください。\n' +
      '・Node.js がある場合: index.html のあるフォルダで\n' +
      '   npx serve .\n' +
      '  を実行し、表示されるURL（http://localhost:... など）をブラウザで開く\n' +
      '・Python がある場合: 同フォルダで\n' +
      '   python3 -m http.server 8000\n' +
      '  を実行し、http://localhost:8000 をブラウザで開く\n' +
      '・VS Code を使っている場合: 「Live Server」拡張機能をインストールし、index.html を右クリックして「Open with Live Server」'
    : '';
  return new Error(reason + howTo);
}

// AudioBufferはWorkerへ直接渡せないため、転送可能な形（チャンネルごとのFloat32Array）に変換する
function audioBufferToTransferable(audioBuffer) {
  const channelData = [];
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    // スライスしてコピーを作る（元のAudioBufferの内部データは転送できないため）
    channelData.push(audioBuffer.getChannelData(ch).slice());
  }
  return {
    sampleRate: audioBuffer.sampleRate,
    duration: audioBuffer.duration,
    numberOfChannels: audioBuffer.numberOfChannels,
    length: audioBuffer.length,
    channelData
  };
}

// Workerに解析を依頼し、進捗コールバックを呼びながら結果を返すPromiseベースの関数
function analyzeAudioInWorker(audioBuffer, mode, params, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = getAnalyzerWorker();
    const audioData = audioBufferToTransferable(audioBuffer);

    const handleMessage = (e) => {
      const { type, payload } = e.data;
      if (type === 'progress') {
        onProgress(payload.fraction, payload.text);
      } else if (type === 'done') {
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
        resolve(payload);
      } else if (type === 'error') {
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
        reject(new Error(payload.message));
      }
    };
    const handleError = (err) => {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      reject(err);
    };

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    const transferList = audioData.channelData.map((arr) => arr.buffer);
    worker.postMessage({ type: 'analyze', payload: { audioData, mode, params } }, transferList);
  });
}

/* =========================================================
   可視化（Canvas描画）
   ========================================================= */

function setupCanvasDPR(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, canvas.parentElement.clientWidth || 800);
  const h = canvas.height;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: w, height: h };
}

function drawWaveform(canvas, peaks) {
  const { ctx, width, height } = setupCanvasDPR(canvas);
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2;

  ctx.strokeStyle = 'rgba(127,224,168,0.06)';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();

  const barW = width / peaks.length;
  ctx.fillStyle = '#3f8362';
  for (let i = 0; i < peaks.length; i++) {
    const [min, max] = peaks[i];
    const x = i * barW;
    const y1 = mid + min * (mid - 4);
    const y2 = mid + max * (mid - 4);
    ctx.fillRect(x, Math.min(y1, y2), Math.max(barW, 1), Math.max(Math.abs(y2 - y1), 1));
  }
}

function drawSpectrogram(canvas, analysis) {
  const { frames, sampleRate, magFlat, magLen } = analysis;
  const { ctx, width, height } = setupCanvasDPR(canvas);
  ctx.clearRect(0, 0, width, height);
  if (frames.length === 0 || !magFlat || !magLen) return;

  const maxBinFreq = 5000;
  const colW = width / frames.length;

  // 事前に最大値を求めてログスケール正規化
  let globalMax = 1e-6;
  for (let i = 0; i < magFlat.length; i++) {
    if (magFlat[i] > globalMax) globalMax = magFlat[i];
  }

  const fftSize = magLen * 2;
  const binHz = sampleRate / fftSize;
  const maxBin = Math.min(magLen, Math.floor(maxBinFreq / binHz));

  for (let fi = 0; fi < frames.length; fi++) {
    const base = fi * magLen;
    const x = fi * colW;

    for (let bi = 1; bi < maxBin; bi++) {
      const val = magFlat[base + bi] / globalMax;
      const logVal = Math.log10(1 + val * 9); // 0-1 log圧縮
      if (logVal < 0.02) continue;
      const freq = bi * binHz;
      const yNorm = 1 - (freq / maxBinFreq);
      const y = yNorm * height;
      const alpha = clamp(logVal, 0, 1);
      const g = Math.floor(100 + alpha * 155);
      ctx.fillStyle = `rgba(127,${g},168,${alpha * 0.9})`;
      ctx.fillRect(x, y, Math.max(colW, 1), height / maxBin + 1);
    }
  }
}

function drawPitchNotes(canvas, analysis) {
  const { frames, notes, duration, noteEnergiesFlat, noteEnergiesLen } = analysis;
  const { ctx, width, height } = setupCanvasDPR(canvas);
  ctx.clearRect(0, 0, width, height);
  if (duration <= 0) return;

  const minMidi = 36, maxMidi = 96; // C2-C7想定範囲（描画用）
  let lo = minMidi, hi = maxMidi;
  notes.forEach((n) => {
    if (n.midi < lo) lo = n.midi - 2;
    if (n.midi > hi) hi = n.midi + 2;
  });
  const span = Math.max(12, hi - lo);

  const xForT = (t) => (t / duration) * width;
  const yForMidi = (m) => height - ((m - lo) / span) * height;

  // 薄いグリッド（オクターブライン）
  ctx.strokeStyle = 'rgba(255,255,255,0.03)';
  ctx.font = '9px monospace';
  ctx.fillStyle = 'rgba(184,196,188,0.3)';
  for (let m = Math.ceil(lo / 12) * 12; m <= hi; m += 12) {
    const y = yForMidi(m);
    ctx.beginPath();
    ctx.moveTo(0, y); ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillText(midiToNoteName(m), 4, y - 2);
  }

  // 生の周波数強度（各フレームで最も強い音階を薄い点として表示）
  if (noteEnergiesFlat && noteEnergiesLen) {
    ctx.fillStyle = 'rgba(127,224,168,0.18)';
    frames.forEach((f, fi) => {
      if (f.isSilent || !f.hasNoteEnergies) return;
      const base = fi * noteEnergiesLen;
      let bestIdx = -1, bestVal = 0;
      for (let i = 0; i < noteEnergiesLen; i++) {
        const v = noteEnergiesFlat[base + i];
        if (v > bestVal) { bestVal = v; bestIdx = i; }
      }
      if (bestIdx < 0) return;
      const m = CHROMA_MIDI_MIN + bestIdx;
      const x = xForT(f.t);
      const y = yForMidi(m);
      ctx.fillRect(x, y, 1.4, 1.4);
    });
  }

  // ノートブロック
  notes.forEach((n) => {
    const x1 = xForT(n.startTime);
    const x2 = xForT(n.endTime);
    const y = yForMidi(n.midi);
    ctx.fillStyle = 'rgba(127,224,168,0.85)';
    ctx.fillRect(x1, y - 3, Math.max(x2 - x1, 2), 6);
    ctx.strokeStyle = 'rgba(232,240,234,0.4)';
    ctx.strokeRect(x1, y - 3, Math.max(x2 - x1, 2), 6);
  });
}

function midiToNoteName(m) {
  const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const octave = Math.floor(m / 12) - 1;
  return names[m % 12] + octave;
}

function drawEventsVelocity(canvas, frames, events, duration) {
  const { ctx, width, height } = setupCanvasDPR(canvas);
  ctx.clearRect(0, 0, width, height);
  if (duration <= 0) return;

  const xForT = (t) => (t / duration) * width;

  // 音量エンベロープ
  ctx.beginPath();
  ctx.strokeStyle = '#3f8362';
  ctx.lineWidth = 1.2;
  frames.forEach((f, i) => {
    const x = xForT(f.t);
    const y = height - clamp((f.db + 55) / 55, 0, 1) * height;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // イベントマーカー
  events.forEach((e) => {
    const x = xForT(e.t);
    ctx.strokeStyle = e.type === 'noise_pulse' ? 'rgba(224,104,92,0.8)' : 'rgba(224,164,88,0.85)';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  });

  // 無音区間の下地
  ctx.fillStyle = 'rgba(224,104,92,0.08)';
  let silentStart = null;
  frames.forEach((f, i) => {
    if (f.isSilent && silentStart === null) silentStart = f.t;
    if (!f.isSilent && silentStart !== null) {
      const x1 = xForT(silentStart), x2 = xForT(f.t);
      ctx.fillRect(x1, 0, x2 - x1, height);
      silentStart = null;
    }
  });
  if (silentStart !== null) {
    const x1 = xForT(silentStart), x2 = xForT(duration);
    ctx.fillRect(x1, 0, x2 - x1, height);
  }
}

function renderAllVisualizations(analysis) {
  drawWaveform(el.cvWave, analysis.waveformPeaks);
  drawSpectrogram(el.cvSpec, analysis);
  drawPitchNotes(el.cvPitch, analysis);
  drawEventsVelocity(el.cvEvent, analysis.frames, analysis.events, analysis.duration);
}

// プレイヘッド描画（軽量オーバーレイは省略、進捗バーで代替）

/* =========================================================
   再生機能
   ========================================================= */
function stopPlayback() {
  const pb = state.playback;
  if (pb.sourceNode) {
    try { pb.sourceNode.stop(); } catch (e) {}
    pb.sourceNode.disconnect();
    pb.sourceNode = null;
  }
  if (pb.raf) { cancelAnimationFrame(pb.raf); pb.raf = null; }
  pb.isPlaying = false;
  el.btnPlay.textContent = '▶';
}

function startPlayback(fromSec) {
  const pb = state.playback;
  stopPlayback();
  const ctx = getAudioCtx();
  const source = ctx.createBufferSource();
  source.buffer = state.audioBuffer;
  source.connect(ctx.destination);
  const offset = clamp(fromSec, 0, state.audioBuffer.duration);
  source.start(0, offset);
  pb.sourceNode = source;
  pb.startedAt = ctx.currentTime;
  pb.offset = offset;
  pb.isPlaying = true;
  el.btnPlay.textContent = '❚❚';

  source.onended = () => {
    if (pb.isPlaying) stopPlayback();
    updatePlaybackUI(0);
  };

  const tick = () => {
    if (!pb.isPlaying) return;
    const elapsed = ctx.currentTime - pb.startedAt + pb.offset;
    updatePlaybackUI(elapsed);
    if (elapsed >= state.audioBuffer.duration) {
      stopPlayback();
      updatePlaybackUI(0);
      return;
    }
    pb.raf = requestAnimationFrame(tick);
  };
  pb.raf = requestAnimationFrame(tick);
}

function updatePlaybackUI(curSec) {
  const dur = state.audioBuffer ? state.audioBuffer.duration : 0;
  el.playTime.textContent = `${formatTime(curSec)} / ${formatTime(dur)}`;
  const pct = dur > 0 ? clamp(curSec / dur, 0, 1) * 100 : 0;
  el.playProgress.style.width = pct + '%';
}

el.btnPlay.addEventListener('click', () => {
  if (!state.audioBuffer) return;
  const pb = state.playback;
  if (pb.isPlaying) {
    // 一時停止：現在位置を記録して停止
    const ctx = getAudioCtx();
    const elapsed = ctx.currentTime - pb.startedAt + pb.offset;
    pb.offset = elapsed;
    stopPlayback();
    updatePlaybackUI(elapsed);
  } else {
    const dur = state.audioBuffer.duration;
    const resumeFrom = pb.offset >= dur ? 0 : pb.offset;
    startPlayback(resumeFrom);
  }
});

el.playTrack.addEventListener('click', (e) => {
  if (!state.audioBuffer) return;
  const rect = el.playTrack.getBoundingClientRect();
  const pct = clamp((e.clientX - rect.left) / rect.width, 0, 1);
  const target = pct * state.audioBuffer.duration;
  state.playback.offset = target;
  if (state.playback.isPlaying) {
    startPlayback(target);
  } else {
    updatePlaybackUI(target);
  }
});

/* =========================================================
   解析実行フロー
   ========================================================= */
function setProgress(fraction, text) {
  el.progressWrap.classList.remove('hidden');
  el.progressFill.style.width = Math.round(fraction * 100) + '%';
  el.progressText.textContent = text;
}

function hideProgress() {
  el.progressWrap.classList.add('hidden');
}

async function runAnalysis() {
  if (!state.audioBuffer || state.isAnalyzing) return;

  // 「和音・密集音」モードは音の密度が高く、長時間の音声（ライブ配信の
  // アーカイブ等）では非常に多くのノートを生成することがある。
  // 内部的な自動調整・セーフガードは備えているが、あまりに長い場合は
  // 解析にかなりの時間がかかるため、事前に一言確認しておく。
  const durationMin = state.audioBuffer.duration / 60;
  const resolvedModeForWarning = state.mode === 'auto' ? null : state.mode;
  const mightUseChroma = state.mode === 'chroma' || state.mode === 'auto';
  if (mightUseChroma && durationMin > 15) {
    const proceed = confirm(
      `読み込んだ音声は約${durationMin.toFixed(0)}分あります。\n\n` +
      `「和音・密集音」モードは音の密度が高いため、長い音声では解析にかなりの時間がかかったり、` +
      `生成されるノート数が非常に多くなることがあります（内部的に自動調整は行われます）。\n\n` +
      `このまま解析を続けますか？`
    );
    if (!proceed) return;
  }

  state.isAnalyzing = true;
  el.btnAnalyze.disabled = true;
  el.btnReanalyze.disabled = true;
  setStatus('解析中...', true);
  setProgress(0, '解析を開始しています...');

  try {
    const analysis = await analyzeAudioInWorker(
      state.audioBuffer,
      state.mode,
      { ...state.params },
      (frac, text) => setProgress(frac, text)
    );

    state.analysis = analysis;
    state.resolvedMode = analysis.resolvedMode;

    setProgress(1, '完了');
    hideProgress();

    // 可視化
    el.vizPanel.classList.remove('hidden');
    renderAllVisualizations(analysis);

    // サマリー
    el.metricsPanel.classList.remove('hidden');
    updateMetrics(analysis);

    // 出力
    el.outputPanel.classList.remove('hidden');

    el.btnReanalyze.disabled = false;
    el.btnAnalyze.disabled = false;
    setStatus('解析完了 — ' + modeLabel(analysis.resolvedMode) + ' として出力可能', true);

    // 再生位置リセット
    state.playback.offset = 0;
    updatePlaybackUI(0);

    notifyAnalysisComplete(analysis);

  } catch (err) {
    console.error(err);
    hideProgress();
    setStatus('解析エラーが発生しました', false);
    alert('解析中にエラーが発生しました。\n\n' + err.message);
    el.btnAnalyze.disabled = false;
  } finally {
    state.isAnalyzing = false;
  }
}

// ---------------------------------------------------------
// 解析完了の通知
// タブがバックグラウンドの間に解析が終わっても気づけるよう、
// ブラウザのNotification APIで通知する。
// ---------------------------------------------------------
function notifyAnalysisComplete(analysis) {
  if (!state.notifyOnComplete) return;
  if (typeof Notification === 'undefined') return;

  const fire = () => {
    try {
      const noteCount = analysis.notes.length;
      const modeName = modeLabel(analysis.resolvedMode);
      const notification = new Notification('音声→MIDI再現：解析が完了しました', {
        body: `${modeName} / ${noteCount}個のノートを検出しました。タブに戻って結果を確認してください。`,
        tag: 'audio2midi-analysis-complete',
        silent: false
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch (e) {
      // Notification生成に失敗しても解析結果自体には影響しないため握りつぶす
      console.warn('通知の表示に失敗しました:', e);
    }
  };

  if (Notification.permission === 'granted') {
    fire();
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') fire();
    });
  }
}

function modeLabel(id) {
  const m = MODES.find((x) => x.id === id);
  return m ? m.name : id;
}

function updateMetrics(analysis) {
  el.mNotes.textContent = analysis.notes.length;
  el.mEvents.textContent = analysis.events.length;

  if (analysis.notes.length > 0) {
    const midis = analysis.notes.map((n) => n.midi);
    const lo = Math.min(...midis), hi = Math.max(...midis);
    el.mRange.textContent = `${midiToNoteName(lo)}–${midiToNoteName(hi)}`;
  } else {
    el.mRange.textContent = '—';
  }

  el.mMode.textContent = modeLabel(analysis.resolvedMode) +
    (analysis.mode === 'auto' ? ' (自動)' : '');
}

el.btnAnalyze.addEventListener('click', runAnalysis);
el.btnReanalyze.addEventListener('click', runAnalysis);

/* =========================================================
   ダウンロード処理
   ========================================================= */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function baseFileName() {
  const name = state.fileName || 'output';
  return name.replace(/\.[^.]+$/, '');
}

el.btnDownloadMidi.addEventListener('click', () => {
  if (!state.analysis || !state.analysis.midiBytes) return;
  const blob = new Blob([state.analysis.midiBytes], { type: 'audio/midi' });
  downloadBlob(blob, baseFileName() + '.mid');
});

el.btnDownloadJson.addEventListener('click', () => {
  if (!state.analysis) return;
  const a = state.analysis;
  const exportData = {
    fileName: state.fileName,
    mode: a.mode,
    resolvedMode: a.resolvedMode,
    sampleRate: a.sampleRate,
    duration: a.duration,
    frameMs: a.frameMs,
    hopMs: a.hopMs,
    notes: a.notes.map((n) => ({
      startTime: n.startTime,
      endTime: n.endTime,
      midi: n.midi,
      noteName: midiToNoteName(n.midi),
      centsOff: Math.round(n.centsOff * 10) / 10,
      velocity: n.velocity,
      confidenceAvg: Math.round(n.confidenceAvg * 1000) / 1000
    })),
    events: a.events.map((e) => ({
      t: Math.round(e.t * 1000) / 1000,
      type: e.type,
      amp: Math.round(e.amp * 1000) / 1000,
      centroid: Math.round(e.centroid)
    })),
    frames: a.frames.map((f, fi) => {
      let peakMidi = null, peakEnergy = 0;
      if (f.hasNoteEnergies && a.noteEnergiesFlat && a.noteEnergiesLen) {
        const base = fi * a.noteEnergiesLen;
        let bestIdx = -1, bestVal = 0;
        for (let i = 0; i < a.noteEnergiesLen; i++) {
          const v = a.noteEnergiesFlat[base + i];
          if (v > bestVal) { bestVal = v; bestIdx = i; }
        }
        if (bestIdx >= 0) { peakMidi = CHROMA_MIDI_MIN + bestIdx; peakEnergy = bestVal; }
      }
      return {
        t: Math.round(f.t * 1000) / 1000,
        db: Math.round(f.db * 10) / 10,
        peakMidi,
        peakEnergy: Math.round(peakEnergy * 1000) / 1000,
        isSilent: f.isSilent
      };
    })
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  downloadBlob(blob, baseFileName() + '_analysis.json');
});

// ウィンドウリサイズ時に可視化を再描画
window.addEventListener('resize', () => {
  if (state.analysis) {
    renderAllVisualizations(state.analysis);
  }
});

// file:// から直接開かれている場合、Web Workerが使えないため
// 解析を試す前の時点で気づけるよう警告バナーを表示しておく。
if (window.location.protocol === 'file:' && el.fileProtocolWarning) {
  el.fileProtocolWarning.classList.remove('hidden');
}
