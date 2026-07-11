'use strict';
/* =========================================================
   analyzer-worker.js
   音声解析エンジンをWeb Worker上で実行するためのスクリプト。
   メインスレッドから切り離すことで、タブがバックグラウンドに
   なっても解析処理がブラウザのタイマー間引き(スロットリング)の
   影響を受けずに進み続けるようにする。
   ========================================================= */

/* =========================================================
   解析エンジン
   ========================================================= */

// ---------------------------------------------------------
// ユーティリティ: dB / 正規化
// ---------------------------------------------------------
function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function dbFromAmplitude(amp) {
  const a = Math.max(amp, 1e-9);
  return 20 * Math.log10(a);
}

// スライダー(0-60) → dB閾値 (-60dB 〜 0dB)
function silenceThreshDb(percent) {
  return -60 + percent; // 0->-60dB(ほぼ常時有音) , 60->0dB(ほぼ常時無音)
}

// ---------------------------------------------------------
// FFT (反復基数2)
// ---------------------------------------------------------
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wI;
        const nextIm = curRe * wI + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
}

function nextPow2(v) {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

function computeSpectrum(frame, minFftSize) {
  const n = Math.max(nextPow2(frame.length), minFftSize || 0);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < frame.length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame.length - 1));
    re[i] = frame[i] * w;
  }
  // frame.lengthよりnが大きい場合、残りは0のまま(ゼロパディング)
  // ゼロパディングはFFTの周波数分解能(見かけ上の細かさ)を上げる一般的な手法。
  // 時間分解能(フレーム長そのもの)は変えない。
  fftInPlace(re, im);
  const half = n / 2;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mag;
}

function spectralCentroid(mag, sampleRate, fftSize) {
  let num = 0, den = 0;
  for (let i = 1; i < mag.length; i++) {
    const freq = i * sampleRate / fftSize;
    num += freq * mag[i];
    den += mag[i];
  }
  return den > 1e-9 ? num / den : 0;
}

/* =========================================================
   クロマ(音階別エネルギー)抽出 — 和音・密集音モード用

   物理的な制約: FFTは時間窓が短いほど周波数分解能が粗くなる
   (不確定性原理)。20msという短いフレームでは、低い音ほど
   隣り合う半音(ドとド#等)を区別できない。
   これを解決するため「マルス解像度分析」を行う:
   低い音域ほど長い時間窓(裏で参照する音声の長さ)を使って
   周波数を正確に求め、高い音域は短い窓のままにする。
   出力されるフレームの間隔(20ms等)自体は変えず、
   各フレーム時刻を中心に必要な長さのデータを追加で切り出して使う。
   ========================================================= */

const CHROMA_MIDI_MIN = 21;  // A0
const CHROMA_MIDI_MAX = 108; // C8

// 音域バンドごとの解析窓長(秒)。低音ほど長い窓が必要。
// (境界のMIDI番号は「このMIDI番号未満はこのバンド」という意味)
const CHROMA_BANDS = [
  { maxMidi: 45, windowSec: 0.5 },   // 〜A2付近: 500ms窓
  { maxMidi: 57, windowSec: 0.3 },   // 〜A3付近: 300ms窓
  { maxMidi: 69, windowSec: 0.15 },  // 〜A4付近: 150ms窓
  { maxMidi: 81, windowSec: 0.075 }, // 〜A5付近: 75ms窓
  { maxMidi: 93, windowSec: 0.04 },  // 〜A6付近: 40ms窓
  { maxMidi: Infinity, windowSec: null } // それ以上: フレームそのもの(20ms)を使用
];

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function bandWindowSec(midi) {
  for (const b of CHROMA_BANDS) {
    if (midi < b.maxMidi) return b.windowSec;
  }
  return null;
}

// 指定した音域範囲[loMidi, hiMidi]に対して、mag/fftSizeからエネルギーを計算し
// energiesOut(CHROMA_MIDI_MIN基準のインデックス)に書き込む
function accumulateNoteEnergies(energiesOut, mag, sampleRate, fftSize, loMidi, hiMidi) {
  const binHz = sampleRate / fftSize;
  const halfSemitoneRatio = Math.pow(2, 1 / 24); // 半音の半分幅で窓を切る

  for (let m = loMidi; m <= hiMidi; m++) {
    const centerFreq = midiToFreq(m);
    const loFreq = centerFreq / halfSemitoneRatio;
    const hiFreq = centerFreq * halfSemitoneRatio;
    const loBin = Math.max(1, Math.floor(loFreq / binHz));
    const hiBin = Math.min(mag.length - 1, Math.ceil(hiFreq / binHz));

    let sum = 0;
    for (let b = loBin; b <= hiBin; b++) {
      const freq = b * binHz;
      if (freq <= 0) continue;
      const distSemi = 12 * Math.log2(freq / centerFreq);
      const weight = Math.exp(-(distSemi * distSemi) / (2 * 0.15 * 0.15));
      sum += mag[b] * weight;
    }
    energiesOut[m - CHROMA_MIDI_MIN] = sum;
  }
}

// マルチ解像度でノートエネルギーを計算する。
// mono: 全体の音声波形(モノラル), centerSample: フレーム中心のサンプル位置
// baseMag/baseFftSize: 通常フレーム長でのFFT結果(高音域バンド用に再利用する)
function computeNoteEnergiesMultiRes(mono, sampleRate, centerSample, baseMag, baseFftSize) {
  const energies = new Float32Array(CHROMA_MIDI_MAX - CHROMA_MIDI_MIN + 1);

  // バンドごとに処理。同じwindowSecのバンドはキャッシュして使い回す
  const cache = new Map();

  let prevMax = CHROMA_MIDI_MIN - 1;
  for (const band of CHROMA_BANDS) {
    const loMidi = Math.max(CHROMA_MIDI_MIN, prevMax + 1);
    const hiMidi = Math.min(CHROMA_MIDI_MAX, band.maxMidi === Infinity ? CHROMA_MIDI_MAX : band.maxMidi);
    if (loMidi > hiMidi) { prevMax = band.maxMidi; continue; }

    if (band.windowSec === null) {
      // 通常フレームのFFT結果をそのまま使う(高音域)
      accumulateNoteEnergies(energies, baseMag, sampleRate, baseFftSize, loMidi, hiMidi);
    } else {
      const key = band.windowSec;
      let entry = cache.get(key);
      if (!entry) {
        const winSamples = Math.round(sampleRate * band.windowSec);
        const half = Math.floor(winSamples / 2);
        const start = Math.max(0, centerSample - half);
        const end = Math.min(mono.length, centerSample + half);
        const slice = mono.subarray(start, end);
        // 長い窓に対しては十分なFFT分解能を確保(ゼロパディングも併用)
        const fftMin = nextPow2(winSamples);
        const mag = computeSpectrum(slice, fftMin);
        const fftSize = Math.max(nextPow2(slice.length), fftMin);
        entry = { mag, fftSize };
        cache.set(key, entry);
      }
      accumulateNoteEnergies(energies, entry.mag, sampleRate, entry.fftSize, loMidi, hiMidi);
    }
    prevMax = band.maxMidi;
  }

  return energies;
}


function zeroCrossingRate(buf) {
  let count = 0;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i - 1] >= 0) !== (buf[i] >= 0)) count++;
  }
  return count / buf.length;
}

/* =========================================================
   フレーム解析パイプライン
   ========================================================= */

// モノラルダウンミックス
function toMono(audioBuffer) {
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i] / ch;
  }
  return out;
}

// 全体的な音源特性を事前スキャンして自動判定・自動フレーム長に使う
function prescan(mono, sampleRate) {
  const winSize = Math.floor(sampleRate * 0.03); // 30ms窓で粗くスキャン
  const hop = winSize;
  let voicedCount = 0, totalCount = 0;
  let highZcrCount = 0;
  let attackCount = 0;
  let prevRms = 0;
  let pitchStableRun = 0, maxStableRun = 0;
  let lastPeakBin = null;

  for (let i = 0; i + winSize <= mono.length; i += hop) {
    const frame = mono.subarray(i, i + winSize);
    const amp = rms(frame);
    const zcr = zeroCrossingRate(frame);
    totalCount++;

    if (amp > prevRms * 2.2 && amp > 0.02) attackCount++;
    prevRms = amp;

    if (amp < 0.005) { pitchStableRun = 0; lastPeakBin = null; continue; }

    // YIN法は使わず、スペクトルの最も強いピーク位置を「音の高さ」の目安として使う
    // (自動判定は「安定しているか」「有声っぽいか」の粗い傾向が分かれば十分なため)
    const mag = computeSpectrum(frame);
    const fftSize = nextPow2(frame.length);
    const binHz = sampleRate / fftSize;
    let peakBin = -1, peakVal = 0, totalEnergy = 0;
    const minBin = Math.max(1, Math.round(60 / binHz));
    const maxBin = Math.min(mag.length - 1, Math.round(1500 / binHz));
    for (let b = minBin; b <= maxBin; b++) {
      totalEnergy += mag[b];
      if (mag[b] > peakVal) { peakVal = mag[b]; peakBin = b; }
    }
    const avgEnergy = totalEnergy / Math.max(1, maxBin - minBin + 1);
    const isVoicedLike = peakVal > avgEnergy * 4; // ピークが平均より十分突出しているか

    if (isVoicedLike) {
      voicedCount++;
      if (lastPeakBin !== null && Math.abs(peakBin - lastPeakBin) <= 1) {
        pitchStableRun++;
      } else {
        pitchStableRun = 1;
      }
      maxStableRun = Math.max(maxStableRun, pitchStableRun);
      lastPeakBin = peakBin;
    } else {
      pitchStableRun = 0;
      lastPeakBin = null;
    }
    if (zcr > 0.15) highZcrCount++;
  }

  const voicedRatio = totalCount > 0 ? voicedCount / totalCount : 0;
  const attackRatio = totalCount > 0 ? attackCount / totalCount : 0;
  const noiseRatio = totalCount > 0 ? highZcrCount / totalCount : 0;
  const stability = totalCount > 0 ? maxStableRun / totalCount : 0;

  return { voicedRatio, attackRatio, noiseRatio, stability };
}

// 自動判定モード解決
function resolveAutoMode(scan) {
  const { voicedRatio, attackRatio, noiseRatio, stability } = scan;

  // 判定の目安（仕様書 7.5）
  if (noiseRatio > 0.45 && voicedRatio < 0.35) return 'noise';
  if (attackRatio > 0.18 && voicedRatio < 0.5) return 'rhythm';
  if (voicedRatio > 0.55 && stability < 0.35) return 'vocal'; // 有声だが不安定=声の抑揚
  if (voicedRatio > 0.5 && stability >= 0.35) return 'monophonic';
  if (voicedRatio > 0.3) return 'vocal';
  return 'noise';
}

// 自動フレーム長解決（仕様書 6.3）
function resolveAutoFrame(scan) {
  const { attackRatio, noiseRatio, stability } = scan;
  if (stability > 0.5 && attackRatio < 0.08) {
    return { frameMs: 30, hopMs: 15 }; // 安定単音多い→長め
  }
  if (attackRatio > 0.18) {
    return { frameMs: 12, hopMs: 6 }; // 衝撃音多い→短め
  }
  if (noiseRatio > 0.4) {
    return { frameMs: 22, hopMs: 11 }; // ノイズ多い→中間
  }
  return { frameMs: 20, hopMs: 10 }; // 声・標準
}

// モードごとのパラメータプロファイル
// ---------------------------------------------------------
// モードごとの設定値
// 全モード共通で「一定時間ごとに区切り、周波数の強弱を見る」という
// 同じ処理を使う。モードの違いは以下のパラメータの差だけに絞る:
//   - maxPolyphony: 1フレームで同時に採用する音階の数（1なら単音、複数なら和音）
//   - minMidi/maxMidi: 対象とする音域の絞り込み
//   - energyThreshold: どれだけ強いエネルギーがあれば「鳴っている」とみなすか
// ---------------------------------------------------------
function modeProfile(mode, params) {
  // 感度(0=最大限拾う 〜 100=強い音だけ拾う)をエネルギー閾値に変換
  const sensitivity = params.noteMerge / 100;
  const baseThreshold = 0.06 + sensitivity * 0.22;

  const base = {
    minMidi: CHROMA_MIDI_MIN,
    maxMidi: CHROMA_MIDI_MAX,
    maxPolyphony: 1,
    energyThreshold: baseThreshold,
    preferEvents: false,
  };

  switch (mode) {
    case 'monophonic':
      // 各フレームで最も強い1音のみを採用（単音のメロディ・旋律向け）
      return { ...base, maxPolyphony: 1 };
    case 'vocal':
      // 人の声の音域(だいたいE2〜E6)に絞り、最も強い1音を採用
      return { ...base, maxPolyphony: 1, minMidi: 40, maxMidi: 88, energyThreshold: baseThreshold * 0.85 };
    case 'rhythm':
      return { ...base, maxPolyphony: 1, preferEvents: true, energyThreshold: baseThreshold * 1.2 };
    case 'noise':
      return { ...base, maxPolyphony: 1, preferEvents: true, energyThreshold: baseThreshold * 1.6 };
    case 'chroma':
      // 和音・密集音: 同時に複数の音階を許可
      return { ...base, maxPolyphony: 8, energyThreshold: baseThreshold };
    default:
      return base;
  }
}

// メインの解析関数
async function analyzeAudio(audioBuffer, mode, params, onProgress) {
  const sampleRate = audioBuffer.sampleRate;
  const mono = toMono(audioBuffer);

  onProgress(0.05, '音源特性をスキャン中...');
  await nextTick();
  const scan = prescan(mono, sampleRate);

  let resolvedMode = mode;
  if (mode === 'auto') {
    resolvedMode = resolveAutoMode(scan);
  }

  let frameMs = params.frameLenMs;
  let hopMs = params.hopLenMs;
  if (params.autoFrame) {
    const auto = resolveAutoFrame(scan);
    frameMs = auto.frameMs;
    hopMs = auto.hopMs;
  }

  const profile = modeProfile(resolvedMode, params);
  const frameSize = Math.max(64, Math.floor(sampleRate * frameMs / 1000));
  const hopSize = Math.max(32, Math.floor(sampleRate * hopMs / 1000));
  const silenceDb = silenceThreshDb(params.silenceThreshPercent);

  onProgress(0.1, 'フレーム分割・周波数解析中...');
  await nextTick();

  const numFrames = Math.max(1, Math.floor((mono.length - frameSize) / hopSize) + 1);
  const frames = [];

  let prevAmp = 0;
  let prevCentroid = 0;

  // ---------------------------------------------------------
  // 全モード共通: 一定時間(フレーム)ごとに区切り、その区間の
  // 周波数ごとの強さ(スペクトル)をそのまま調べる、というシンプルな方式。
  // 「主周波数を1つ推定する」といった特殊な計算(YIN法等)は使わず、
  // 音階(MIDIノート)ごとのエネルギーを直接計算する。
  // ---------------------------------------------------------
  for (let fi = 0; fi < numFrames; fi++) {
    const start = fi * hopSize;
    const buf = mono.subarray(start, start + frameSize);
    const timeSec = start / sampleRate;

    const amp = rms(buf);
    const db = dbFromAmplitude(amp);
    const isSilent = db < silenceDb;

    const mag = computeSpectrum(buf);
    const fftSize = nextPow2(buf.length);
    const centroid = spectralCentroid(mag, sampleRate, fftSize);
    const zcr = zeroCrossingRate(buf);

    // 音階(MIDIノート)ごとのエネルギーをマルチ解像度で計算。
    // 低音域ほど長い時間窓を裏で参照し、高音域は通常フレームのFFT結果を使う。
    let noteEnergies = null;
    if (!isSilent) {
      const centerSample = start + Math.floor(frameSize / 2);
      noteEnergies = computeNoteEnergiesMultiRes(mono, sampleRate, centerSample, mag, fftSize);
    }

    // イベント（立ち上がり）検出用の差分特徴
    const ampJump = amp - prevAmp;
    const centroidJump = Math.abs(centroid - prevCentroid);
    prevAmp = amp;
    prevCentroid = centroid;

    frames.push({
      t: timeSec, amp, db, isSilent,
      centroid, zcr, ampJump, centroidJump, mag, noteEnergies
    });

    if (fi % 50 === 0) {
      onProgress(0.1 + 0.35 * (fi / numFrames), `フレーム解析中... (${fi}/${numFrames})`);
      await nextTick();
    }
  }

  onProgress(0.5, 'イベント検出中...');
  await nextTick();
  const events = detectEvents(frames, params, profile);

  onProgress(0.7, '音階ごとの強さからノートを作成中...');
  await nextTick();
  const notes = buildSpectralNotes(frames, hopMs, params, profile, resolvedMode);

  // ---------------------------------------------------------
  // 絶対的な上限チェック（最終防衛ライン）
  // 動的セーフガード（buildFullSpectrumNotes内）を通しても、
  // 万が一ノート数が極端に多くなった場合、MIDIファイルの組み立て
  // （toBytes等）でメモリ不足に陥る可能性がある。ここで安全な
  // 範囲に収まっているか最終確認し、超えていれば分かりやすい
  // エラーメッセージで処理を打ち切る（原因不明のクラッシュを防ぐ）。
  // ---------------------------------------------------------
  const HARD_NOTE_LIMIT = 1000000;
  if (notes.length > HARD_NOTE_LIMIT) {
    throw new Error(
      `生成されたノート数が非常に多くなりすぎたため（約${notes.length.toLocaleString()}件）、処理を中止しました。` +
      '音声が長い場合は「和音・密集音」モード以外を試すか、音声を短く分割してから解析することをおすすめします。'
    );
  }

  onProgress(0.95, '結果をまとめています...');
  await nextTick();

  // 波形描画用のダウンサンプル
  const waveformPeaks = buildWaveformPeaks(mono, 1200);

  return {
    mode, resolvedMode, scan,
    sampleRate, duration: audioBuffer.duration,
    frameMs, hopMs, frameSize, hopSize,
    frames, events, notes,
    waveformPeaks
  };
}

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------
// イベント検出（仕様書 11章）
// ---------------------------------------------------------
function detectEvents(frames, params, profile) {
  const events = [];
  const sensThresh = 0.35 - (params.eventSens / 100) * 0.25; // 感度高いほど閾値下げる
  const ampThresh = Math.max(0.02, sensThresh);

  for (let i = 2; i < frames.length; i++) {
    const f = frames[i];
    const isAttack = f.ampJump > ampThresh && f.amp > 0.015;
    const isSpectralJump = f.centroidJump > 800 && f.amp > 0.01;
    const isNoisyPulse = f.zcr > 0.22 && f.amp > 0.02;

    if (isAttack || isSpectralJump || isNoisyPulse) {
      // 直前0.03秒以内に既にイベントがあれば統合
      const last = events[events.length - 1];
      if (last && (f.t - last.t) < 0.03) continue;

      let type = 'attack';
      if (isNoisyPulse && !isAttack) type = 'noise_pulse';
      else if (isSpectralJump && !isAttack) type = 'spectral_change';

      events.push({
        t: f.t,
        amp: f.amp,
        type,
        centroid: f.centroid
      });
    }
  }
  return events;
}

// ---------------------------------------------------------
// スペクトルベースのノート化（全モード共通のコアロジック）
//
// 考え方はシンプル:
//   1. 各フレーム（一定時間）ごとに、どの音階がどれくらい強く
//      鳴っているか（noteEnergies）は既に計算済み
//   2. そのエネルギーが閾値を超えている音階を「鳴っている」とみなす
//   3. モードに応じて、同時に採用する音階の数を絞る
//      （maxPolyphony=1なら最も強い1音だけ、複数ならその数まで）
//   4. 同じ音階が連続して鳴っている間は1つのノートとしてつなげる
//
// YIN法のような「主周波数を1つ推定する」特殊な計算は行わず、
// スペクトル（周波数ごとの強さ）をそのまま見て判断する。
// ---------------------------------------------------------
function buildSpectralNotes(frames, hopMs, params, profile, resolvedMode) {
  if (resolvedMode === 'chroma') {
    return buildFullSpectrumNotes(frames, hopMs, params, profile);
  }

  const numNotes = CHROMA_MIDI_MAX - CHROMA_MIDI_MIN + 1;
  const minNoteSec = params.minNoteMs / 1000;
  const minMidiIdx = Math.max(0, profile.minMidi - CHROMA_MIDI_MIN);
  const maxMidiIdx = Math.min(numNotes - 1, profile.maxMidi - CHROMA_MIDI_MIN);
  const maxPolyphony = profile.maxPolyphony || 1;

  // 全フレーム・全音階を通じての最大エネルギーで正規化(相対的な強弱を保つ)
  let globalMax = 1e-9;
  frames.forEach((f) => {
    if (!f.noteEnergies) return;
    for (let i = minMidiIdx; i <= maxMidiIdx; i++) {
      if (f.noteEnergies[i] > globalMax) globalMax = f.noteEnergies[i];
    }
  });

  const onThreshold = profile.energyThreshold;
  const offThreshold = onThreshold * 0.6; // ヒステリシス(切れ目のチラつき防止)

  // 各音階ごとに「鳴っている/いない」の状態機械を回してノートを作る
  const notes = [];
  const active = new Array(numNotes).fill(null);

  const flushNote = (noteIdx, endFrameIdx) => {
    const cur = active[noteIdx];
    if (!cur) return;
    const startFrame = frames[cur.startIdx];
    const endFrame = frames[endFrameIdx - 1] || startFrame;
    const durSec = endFrame.t - startFrame.t + (hopMs / 1000);

    if (durSec * 1000 >= minNoteSec * 1000 * 0.6) {
      const avgEnergy = cur.energySum / cur.frameCount;
      const norm = Math.min(1, avgEnergy / globalMax);
      const sens = params.velSensPercent / 100;
      const baseVel = 18 + norm * 109;
      const velocity = Math.max(1, Math.min(127, Math.round(baseVel * sens + baseVel * (1 - sens) * 0.6)));
      notes.push({
        startTime: startFrame.t,
        endTime: endFrame.t + (hopMs / 1000),
        midi: CHROMA_MIDI_MIN + noteIdx,
        centsOff: 0,
        velocity,
        frameIndices: [],
        pitchBendCurve: [],
        expressionCurve: [],
        confidenceAvg: 1
      });
    }
    active[noteIdx] = null;
  };

  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    if (!f.noteEnergies || f.isSilent) {
      for (let n = minMidiIdx; n <= maxMidiIdx; n++) {
        if (active[n]) flushNote(n, fi);
      }
      continue;
    }

    // このフレームで「鳴っている」候補として使う音階を決める。
    // maxPolyphonyで上限を絞る場合は、エネルギーが強い順に選ぶ。
    let candidateIdxs;
    if (maxPolyphony >= (maxMidiIdx - minMidiIdx + 1)) {
      // 制限なし(和音・密集音モード): 閾値を超えた全音階が対象
      candidateIdxs = null; // 後段で全音階を閾値判定する
    } else {
      const ranked = [];
      for (let n = minMidiIdx; n <= maxMidiIdx; n++) {
        const norm = f.noteEnergies[n] / globalMax;
        if (norm >= offThreshold) ranked.push([n, norm]);
      }
      ranked.sort((a, b) => b[1] - a[1]);
      candidateIdxs = new Set(ranked.slice(0, maxPolyphony).map((x) => x[0]));
    }

    for (let n = minMidiIdx; n <= maxMidiIdx; n++) {
      const norm = f.noteEnergies[n] / globalMax;
      const isCandidate = candidateIdxs === null || candidateIdxs.has(n);
      const isOn = active[n] !== null;

      if (!isOn && isCandidate && norm >= onThreshold) {
        active[n] = { startIdx: fi, energySum: f.noteEnergies[n], frameCount: 1 };
      } else if (isOn && isCandidate && norm >= offThreshold) {
        active[n].energySum += f.noteEnergies[n];
        active[n].frameCount++;
      } else if (isOn) {
        flushNote(n, fi);
      }
    }
  }
  for (let n = minMidiIdx; n <= maxMidiIdx; n++) {
    if (active[n]) flushNote(n, frames.length);
  }

  notes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);
  return notes;
}

// ---------------------------------------------------------
// 和音・密集音モード専用: 閾値でふるいにかけず、
// 検出できた周波数成分はすべて音として出し、強さだけをベロシティ
// （および時間変化はエクスプレッション曲線）に反映する。
// 「鳴っている/いない」の二択ではなく「どれだけ振動しているか」を
// そのまま音の強さとして表現する方式。
// ---------------------------------------------------------
function buildFullSpectrumNotes(frames, hopMs, params) {
  const numNotes = CHROMA_MIDI_MAX - CHROMA_MIDI_MIN + 1;
  const minNoteSec = params.minNoteMs / 1000;

  // 長時間の音声（ライブ配信のアーカイブ等）を和音・密集音モードで
  // 扱うと、フレーム数に比例してノート候補も増え、数十分を超えると
  // 数十万〜数百万ノートに達してメモリ不足を招くことがある。
  // これを避けるため、音声が長いほど「鳴っている」と判定する閾値を
  // 自動的に厳しくし、そもそも生成されるノートの総数を抑える。
  const totalDurationSec = frames.length > 0 ? frames[frames.length - 1].t : 0;
  // 10分までは変更なし。そこから緩やかに厳しくし、1時間程度で
  // 閾値を大きく引き上げる（弱い音を間引く）。
  const durationScale = 1 + clamp((totalDurationSec - 600) / 3000, 0, 2);
  const thresholdScale = 1 + clamp((totalDurationSec - 600) / 1800, 0, 4); // 10分〜40分でx1〜x5

  // 全フレーム・全音階を通じての最大エネルギー（参考値、ノイズフロア計算に使う）
  let globalMax = 1e-9;
  frames.forEach((f) => {
    if (!f.noteEnergies) return;
    for (let i = 0; i < numNotes; i++) {
      if (f.noteEnergies[i] > globalMax) globalMax = f.noteEnergies[i];
    }
  });

  // 音階ごとの最大エネルギーで正規化する。
  // 一般的な音（声・楽器）は低音域（基音）に最もエネルギーが集中し、
  // 高音域（倍音）はもともと絶対的な強さが弱い。そのため全音域共通の
  // 基準（globalMax）だけで判定すると、高音は閾値を超えにくく
  // 「低音ばかり検出され、高音は薄くしか出ない」という偏りが生まれる。
  // これを避けるため、各音階は「その音階自身が曲中で出した最大値」を
  // 基準にした相対的な強さで評価する（音階ごとの正規化）。
  const perNoteMax = new Float32Array(numNotes).fill(1e-9);
  frames.forEach((f) => {
    if (!f.noteEnergies) return;
    for (let i = 0; i < numNotes; i++) {
      if (f.noteEnergies[i] > perNoteMax[i]) perNoteMax[i] = f.noteEnergies[i];
    }
  });

  // 「鳴っている」とみなす下限は、実質ゼロ（ノイズフロア）とみなせる
  // 程度のごく小さい値に固定する。こちらは音階ごとの正規化とは別に、
  // 全体的な無音区間・暗騒音を弾くための絶対的な足切りとして使う。
  // 長い音声ではthresholdScaleにより自動的に厳しくなる。
  const noiseFloor = globalMax * 0.006 * thresholdScale;

  // ---------------------------------------------------------
  // 声の自然な音域からの逸脱を抑える
  // 一般的な人の声（地声〜裏声）の範囲を大きく外れる音域は、
  // ノイズや倍音の誤検出である可能性が高く、そのまま同じ強さで
  // 鳴らすと不自然に聞こえる。そこで、指定した範囲の外側にある
  // 音階は、範囲の境界に近いほど弱く（なだらかに減衰）、
  // 大きく外れるほどさらに弱くする。
  // 急に音量差を付けると逆に不自然になるため、範囲の境界前後は
  // なめらかに変化させる（ハードカットではない）。
  // ---------------------------------------------------------
  const centerOnMelody = !!params.centerOnMelody;
  // 既定は「ラ(A2, MIDI45) 〜 ラ(A6, MIDI93)」。この範囲の外側を減衰させる。
  const RANGE_LOW = 45;
  const RANGE_HIGH = 93;
  const ROLLOFF_SEMITONES = 6; // 境界からこの半音数でなだらかに減衰しきる

  const rangeWeight = (noteIdx) => {
    const midi = CHROMA_MIDI_MIN + noteIdx;
    if (midi >= RANGE_LOW && midi <= RANGE_HIGH) return 1;
    const dist = midi < RANGE_LOW ? (RANGE_LOW - midi) : (midi - RANGE_HIGH);
    // 境界からdist半音離れるごとになだらかに減衰し、ROLLOFF_SEMITONESで最低値に達する
    const t = clamp(dist / ROLLOFF_SEMITONES, 0, 1);
    // なめらかな減衰カーブ（急に0にはせず、最低でも0.15程度は残す）
    return 1 - t * t * (3 - 2 * t) * 0.85; // smoothstepベース、最低0.15
  };

  const notes = [];
  const active = new Array(numNotes).fill(null);

  // 動的セーフガード用の状態。ノート数が多くなりすぎたら
  // isAudible の閾値をその場で引き上げ、以降の生成を抑制する。
  // （メモリ不足クラッシュを防ぐための最終防衛ライン）
  const NOTE_COUNT_SOFT_LIMIT = 300000;
  const dynamicThresholdBoosted = { value: false };

  const velocityFromEnergy = (energy, noteIdx) => {
    // エネルギーをそのまま線形でベロシティにすると、強い音とごく弱い音の
    // 差が大きすぎて、大半の音がベロシティ2〜3付近に埋もれてしまう。
    // 人の耳の音量感覚は対数的なので、dB(対数)スケールに変換してから
    // ベロシティへ割り当てることで、弱い音も相対的に聞き取れる強さにする。
    const norm = Math.min(1, energy / perNoteMax[noteIdx]);
    const db = 20 * Math.log10(Math.max(norm, 1e-6)); // 0dB(最大)〜-120dB程度
    // sens=100%: -36dBまでの範囲をベロシティに割り当てる(圧縮弱め、メリハリ重視)
    // sens=0%:   -60dBまでの範囲を割り当てる(圧縮強め、弱い音も持ち上げる)
    const sens = params.velSensPercent / 100;
    const dbRange = 36 + (1 - sens) * 24; // 36dB(sens=100%) 〜 60dB(sens=0%)
    const dbNorm = clamp((db + dbRange) / dbRange, 0, 1);
    // 「鳴らす」と判定された音は、どれだけ弱くても最低30は超えるようにする。
    // (30未満だとMIDI音源によってはほぼ聞こえないため)
    const MIN_VEL = 32;
    let velocity = MIN_VEL + dbNorm * (127 - MIN_VEL);

    if (centerOnMelody) {
      const weight = rangeWeight(noteIdx);
      velocity = MIN_VEL + (velocity - MIN_VEL) * weight;
    }

    return Math.max(MIN_VEL, Math.min(127, Math.round(velocity)));
  };

  const flushNote = (noteIdx, endFrameIdx) => {
    const cur = active[noteIdx];
    if (!cur) return;
    const startFrame = frames[cur.startIdx];
    const endFrame = frames[endFrameIdx - 1] || startFrame;
    const durSec = endFrame.t - startFrame.t + (hopMs / 1000);

    // 全部鳴らす方針でも、あまりに短い音は最小ノート長で間引く
    if (durSec * 1000 >= minNoteSec * 1000 * 0.6) {
      const avgVelocity = Math.round(cur.velSum / cur.frameCount);
      // ノート内でのベロシティの時間変化をエクスプレッション(CC11)として残す。
      // 3フレームに1回程度の間引きで十分（データ量を抑えつつ強弱の推移は残す）
      const expressionCurve = [];
      const step = Math.max(1, Math.floor(cur.velTrack.length / 40));
      for (let i = 0; i < cur.velTrack.length; i += step) {
        expressionCurve.push({ t: cur.velTrack[i].t, value: cur.velTrack[i].vel });
      }
      notes.push({
        startTime: startFrame.t,
        endTime: endFrame.t + (hopMs / 1000),
        midi: CHROMA_MIDI_MIN + noteIdx,
        centsOff: 0,
        velocity: Math.max(1, Math.min(127, avgVelocity)),
        frameIndices: [],
        pitchBendCurve: [],
        expressionCurve,
        confidenceAvg: 1
      });

      // ---------------------------------------------------------
      // 動的セーフガード: 事前の見積もりだけに頼らず、実際に生成
      // されたノート数がハードリミットに近づいたら、その場で
      // 閾値を引き上げてノート生成を強制的に抑制する。
      // 音声の内容次第で見積もりが外れることがあるため、実測値に
      // 基づくこの仕組みが最終防衛ラインとしてメモリ不足クラッシュを
      // 確実に防ぐ。
      // ---------------------------------------------------------
      if (notes.length > NOTE_COUNT_SOFT_LIMIT && !dynamicThresholdBoosted.value) {
        dynamicThresholdBoosted.value = true;
      }
    }
    active[noteIdx] = null;
  };

  // 音域によって窓長が異なるため、放っておくと低音域ほど
  // エネルギーがなだらかに変化してノートが長く伸びやすく、
  // 高音域ほど短く刻まれやすいという偏りが出る。
  // 「短く細かく刻む」方向に統一するため、ノートの最大長に
  // 上限を設け、それを超えたら一度区切って鳴らし直す。
  //
  // ただし「音声の周波数を中心にプロット」がオンの場合は、
  // 声の自然な音域（RANGE_LOW〜RANGE_HIGH）については、
  // 短く刻むとかえって声がスタッカートのように不自然に
  // 聞こえてしまうため、この上限を大幅に緩めてなめらかに
  // 伸ばす。範囲の外側（元々ノイズ等で弱められている音域）は
  // 従来通り短く刻んだままにする。
  //
  // 長時間の音声（ライブ配信のアーカイブ等）を和音・密集音モードで
  // 扱うと、細かく刻むほどノート数が音声の長さに比例して増え、
  // 数十分を超えると数十万〜数百万ノートに達してメモリ不足を
  // 招くことがある。これを避けるため、音声が長いほど「短く刻む」側の
  // 上限も自動的に緩め、ノート数の増加を抑える
  // （durationScaleは冒頭で算出済み）。
  const maxNoteSecShort = Math.max(0.06, (hopMs / 1000) * 4) * durationScale; // フレーム4個分程度が上限の目安
  const maxNoteSecLong = 2.0 * durationScale; // 声の自然な音域はここまで伸ばしてよい
  const maxNoteSecFor = (noteIdx) => {
    if (centerOnMelody) {
      const midi = CHROMA_MIDI_MIN + noteIdx;
      if (midi >= RANGE_LOW && midi <= RANGE_HIGH) return maxNoteSecLong;
    }
    return maxNoteSecShort;
  };

  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    if (!f.noteEnergies || f.isSilent) {
      for (let n = 0; n < numNotes; n++) {
        if (active[n]) flushNote(n, fi);
      }
      continue;
    }

    for (let n = 0; n < numNotes; n++) {
      const energy = f.noteEnergies[n];
      // 「鳴っている」の判定は次の2つのANDにする:
      //   1. 全体としてノイズフロア(絶対的な暗騒音)を超えているか
      //   2. その音階自身が曲中で出した最大値に対して、無視できない
      //      割合まで達しているか（通常1%程度。長い音声ほど
      //      thresholdScaleにより自動的に厳しくし、ノート数の
      //      増加を抑える）
      // 2番目の条件により、高音域（絶対値は小さいが、その音階の中では
      // 十分に強い瞬間）も低音域と同じ基準で公平に拾えるようになる。
      const isAudible = energy > noiseFloor &&
        energy > perNoteMax[n] * 0.01 * thresholdScale * (dynamicThresholdBoosted.value ? 8 : 1);
      const isOn = active[n] !== null;
      const vel = velocityFromEnergy(energy, n);

      if (!isOn && isAudible) {
        active[n] = { startIdx: fi, velSum: vel, frameCount: 1, velTrack: [{ t: f.t, vel }] };
      } else if (isOn && isAudible) {
        const elapsedSec = f.t - frames[active[n].startIdx].t;
        if (elapsedSec >= maxNoteSecFor(n)) {
          // 上限に達したので一度区切り、同じフレームから新しいノートとして続ける
          flushNote(n, fi);
          active[n] = { startIdx: fi, velSum: vel, frameCount: 1, velTrack: [{ t: f.t, vel }] };
        } else {
          active[n].velSum += vel;
          active[n].frameCount++;
          active[n].velTrack.push({ t: f.t, vel });
        }
      } else if (isOn) {
        flushNote(n, fi);
      }
    }
  }
  for (let n = 0; n < numNotes; n++) {
    if (active[n]) flushNote(n, frames.length);
  }

  notes.sort((a, b) => a.startTime - b.startTime || a.midi - b.midi);
  return notes;
}


function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/* =========================================================
   波形ピーク生成（可視化用ダウンサンプル）
   ========================================================= */
function buildWaveformPeaks(mono, numBuckets) {
  const bucketSize = Math.max(1, Math.floor(mono.length / numBuckets));
  const peaks = [];
  for (let i = 0; i < numBuckets; i++) {
    const start = i * bucketSize;
    const end = Math.min(mono.length, start + bucketSize);
    let min = 1, max = -1;
    for (let j = start; j < end; j++) {
      if (mono[j] < min) min = mono[j];
      if (mono[j] > max) max = mono[j];
    }
    if (start >= mono.length) { min = 0; max = 0; }
    peaks.push([min, max]);
  }
  return peaks;
}

/* =========================================================
   MIDI生成（仕様書 13章）
   ========================================================= */

// GM ドラムマップ（仕様書 13.3）
const DRUM_NOTES = {
  low: 36,      // バスドラム
  sharp: 38,    // スネア
  metallic: 42, // クローズドハイハット
  sudden: 49    // クラッシュシンバル
};

function classifyEventToDrum(evt) {
  if (evt.type === 'noise_pulse') {
    return evt.centroid > 4000 ? DRUM_NOTES.metallic : DRUM_NOTES.sharp;
  }
  if (evt.type === 'spectral_change') {
    return DRUM_NOTES.sudden;
  }
  // attack: 低域中心なら低い衝撃、高域なら鋭い破裂音
  if (evt.centroid < 400) return DRUM_NOTES.low;
  if (evt.centroid > 3500) return DRUM_NOTES.metallic;
  return DRUM_NOTES.sharp;
}

function eventVelocity(evt) {
  const db = dbFromAmplitude(evt.amp);
  const norm = clamp((db + 45) / 40, 0, 1);
  return Math.round(clamp(30 + norm * 90, 1, 127));
}

/* ---------------- Variable Length Quantity ---------------- */
function writeVarLen(value) {
  const bytes = [];
  let buffer = value & 0x7f;
  value >>= 7;
  while (value > 0) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
    value >>= 7;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

// writeVarLenのTypedArray直接書き込み版。
// 大量イベントを扱う toBytes() で、通常配列への1バイトずつのpushを
// 避けるために使う（詳細は toBytes() 内のコメントを参照）。
function writeVarLenInto(buf, pos, value) {
  let buffer = value & 0x7f;
  value >>= 7;
  while (value > 0) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
    value >>= 7;
  }
  while (true) {
    buf[pos++] = buffer & 0xff;
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return pos;
}

/* ---------------- MIDIバイトビルダー ---------------- */
class MidiTrackBuilder {
  constructor(name) {
    this.events = []; // { tick, bytes: [] }
    if (name) {
      this.events.push({ tick: 0, bytes: this.metaText(0x03, name) });
    }
  }
  metaText(type, text) {
    const bytes = [0xff, type];
    const strBytes = Array.from(new TextEncoder().encode(text));
    bytes.push(...writeVarLen(strBytes.length));
    bytes.push(...strBytes);
    return bytes;
  }
  programChange(tick, channel, program) {
    this.events.push({ tick, bytes: [0xc0 | channel, program & 0x7f] });
  }
  noteOn(tick, channel, note, velocity) {
    this.events.push({ tick, bytes: [0x90 | channel, note & 0x7f, velocity & 0x7f] });
  }
  noteOff(tick, channel, note) {
    this.events.push({ tick, bytes: [0x80 | channel, note & 0x7f, 0x00] });
  }
  controlChange(tick, channel, controller, value) {
    this.events.push({ tick, bytes: [0xb0 | channel, controller & 0x7f, value & 0x7f] });
  }
  pitchBend(tick, channel, value14) {
    // value14: 0-16383, 8192が中央
    const lsb = value14 & 0x7f;
    const msb = (value14 >> 7) & 0x7f;
    this.events.push({ tick, bytes: [0xe0 | channel, lsb, msb] });
  }
  // ピッチベンドレンジをRPN(Registered Parameter Number)で設定する。
  // rangeSemitones: ±何半音までベンドできるか(一般的な既定値は2)
  setPitchBendRange(tick, channel, rangeSemitones) {
    this.controlChange(tick, channel, 101, 0);      // RPN MSB = 0 (Pitch Bend Range)
    this.controlChange(tick, channel, 100, 0);      // RPN LSB = 0
    this.controlChange(tick, channel, 6, rangeSemitones & 0x7f);   // Data Entry MSB = 半音数
    this.controlChange(tick, channel, 38, 0);       // Data Entry LSB = 0(セント未満は使わない)
    this.controlChange(tick, channel, 101, 0x7f);   // RPN NULL(以降の誤設定防止)
    this.controlChange(tick, channel, 100, 0x7f);
  }
  endOfTrack(tick) {
    this.events.push({ tick, bytes: [0xff, 0x2f, 0x00] });
  }

  toBytes() {
    // tick順にソート（同tickはイベント追加順を維持: stable sort）。
    // Array.prototype.sortはstableなので、_i を使った複製は不要
    // （元のインデックス順は配列の並び自体で保たれる）。
    const sorted = this.events.slice().sort((a, b) => a.tick - b.tick);

    // ---------------------------------------------------------
    // 大量のノート（長時間・和音モード等で数十万〜数百万イベントに
    // なりうる）を扱う際、通常のJS配列に1バイトずつpushしていく
    // 実装だと、配列の要素がすべて「ボックス化された数値」として
    // メモリに保持されるため非常に重く、長時間の音源では
    // メモリ不足でクラッシュすることがあった。
    // そこで、最初にバイト数の上限を見積もって Uint8Array を
    // 確保し、そこへ直接書き込む方式に変更する（1バイト=1要素の
    // TypedArrayなので、通常配列よりずっと省メモリになる）。
    // ---------------------------------------------------------
    // 1イベントの最大バイト数を安全側に見積もる:
    //   デルタタイム(可変長, 最大4バイト程度) + イベント本体(最大3バイト)
    const maxBytesPerEvent = 8;
    const buf = new Uint8Array(sorted.length * maxBytesPerEvent);
    let pos = 0;
    let lastTick = 0;

    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      const delta = Math.max(0, e.tick - lastTick);
      pos = writeVarLenInto(buf, pos, delta);
      const eb = e.bytes;
      for (let j = 0; j < eb.length; j++) buf[pos++] = eb[j];
      lastTick = e.tick;
    }

    const trackData = buf.subarray(0, pos);
    const header = new Uint8Array(8);
    const dv = new DataView(header.buffer);
    header[0] = 0x4d; header[1] = 0x54; header[2] = 0x72; header[3] = 0x6b; // "MTrk"
    dv.setUint32(4, trackData.length, false);
    const out = new Uint8Array(header.length + trackData.length);
    out.set(header, 0);
    out.set(trackData, header.length);
    return out;
  }
}

const TICKS_PER_QUARTER = 480;
const ASSUMED_BPM = 120; // 秒→tick変換の基準（見た目のテンポで実時間は保持される）

function secToTick(sec) {
  const ticksPerSec = (TICKS_PER_QUARTER * ASSUMED_BPM) / 60;
  return Math.round(sec * ticksPerSec);
}

function buildMidiFile(analysis, params) {
  const { notes, events, resolvedMode } = analysis;
  const trackMode = params.trackMode;
  const program = resolveInstrumentProgram(params, resolvedMode);

  const tracks = [];

  if (trackMode === 'single') {
    const t = new MidiTrackBuilder('Signal/MIDI - Unified');
    t.programChange(0, 0, program);
    addNotesToTrack(t, notes, 0, params, resolvedMode);
    if (resolvedMode === 'rhythm' || resolvedMode === 'noise') {
      addEventsToTrack(t, events, 9); // ドラムチャンネル10(0-index 9)にまとめる
    }
    t.endOfTrack(finalTick(notes, events));
    tracks.push(t);
  } else {
    // トラック1: 音高成分
    const pitchTrack = new MidiTrackBuilder('Pitch');
    pitchTrack.programChange(0, 0, program);
    addNotesToTrack(pitchTrack, notes, 0, params, resolvedMode);
    pitchTrack.endOfTrack(finalTick(notes, []));
    tracks.push(pitchTrack);

    // トラック2: リズム成分（ドラムイベント）
    const rhythmEvents = events.filter((e) => e.type === 'attack');
    const rhythmTrack = new MidiTrackBuilder('Rhythm');
    addEventsToTrack(rhythmTrack, rhythmEvents, 9);
    rhythmTrack.endOfTrack(finalTick([], rhythmEvents));
    tracks.push(rhythmTrack);

    // トラック3: ノイズ・効果音成分
    const noiseEvents = events.filter((e) => e.type === 'noise_pulse');
    const noiseTrack = new MidiTrackBuilder('Noise / FX');
    addEventsToTrack(noiseTrack, noiseEvents, 9);
    noiseTrack.endOfTrack(finalTick([], noiseEvents));
    tracks.push(noiseTrack);

    // トラック4: 補助表現（スペクトル変化イベント）
    const auxEvents = events.filter((e) => e.type === 'spectral_change');
    const auxTrack = new MidiTrackBuilder('Auxiliary');
    addEventsToTrack(auxTrack, auxEvents, 9);
    auxTrack.endOfTrack(finalTick([], auxEvents));
    tracks.push(auxTrack);
  }

  return assembleSmf(tracks);
}

// ユーザーが音色を指定していればそれを優先し、'auto'ならモードに応じた既定音色を使う
function resolveInstrumentProgram(params, mode) {
  if (params.instrument !== undefined && params.instrument !== 'auto') {
    return Number(params.instrument);
  }
  return instrumentForMode(mode);
}

function instrumentForMode(mode) {
  switch (mode) {
    case 'vocal': return 53;       // Voice Oohs
    case 'monophonic': return 0;   // Acoustic Grand Piano
    case 'rhythm': return 0;
    case 'noise': return 96;       // FX (rain) 系のパッド
    case 'chroma': return 0;       // Acoustic Grand Piano(和音を鳴らすのに適する)
    default: return 0;
  }
}

function addNotesToTrack(track, notes, channel, params, mode) {
  const rangeSemis = 2;
  if (params.pitchBend) {
    track.setPitchBendRange(0, channel, rangeSemis);
  }

  notes.forEach((note) => {
    const startTick = secToTick(note.startTime);
    const endTick = Math.max(startTick + 1, secToTick(note.endTime));

    // ピッチベンド（ノートオン直前にリセット→開始）
    if (params.pitchBend && note.pitchBendCurve && note.pitchBendCurve.length > 1) {
      note.pitchBendCurve.forEach((pb) => {
        const bendTick = secToTick(pb.t);
        const semis = pb.cents / 100;
        const norm = clamp(semis / rangeSemis, -1, 1);
        const value14 = Math.round(8192 + norm * 8191);
        track.pitchBend(Math.max(startTick, bendTick), channel, value14);
      });
    }

    // エクスプレッション(CC11)
    if (note.expressionCurve && note.expressionCurve.length > 1) {
      let lastVal = -1;
      note.expressionCurve.forEach((ex) => {
        if (Math.abs(ex.value - lastVal) < 3) return;
        lastVal = ex.value;
        const exTick = secToTick(ex.t);
        track.controlChange(Math.max(startTick, exTick), channel, 11, ex.value);
      });
    }

    track.noteOn(startTick, channel, note.midi, note.velocity);
    track.noteOff(endTick, channel, note.midi);

    // ベンドを中央に戻す
    if (params.pitchBend) {
      track.pitchBend(endTick, channel, 8192);
    }
  });
}

function addEventsToTrack(track, events, channel) {
  events.forEach((evt) => {
    const tick = secToTick(evt.t);
    const drumNote = classifyEventToDrum(evt);
    const vel = eventVelocity(evt);
    track.noteOn(tick, channel, drumNote, vel);
    track.noteOff(tick + 30, channel, drumNote);
  });
}

function finalTick(notes, events) {
  let maxT = 0;
  notes.forEach((n) => { if (n.endTime > maxT) maxT = n.endTime; });
  events.forEach((e) => { if (e.t > maxT) maxT = e.t; });
  return secToTick(maxT) + 240;
}

function assembleSmf(tracks) {
  const headerData = new Uint8Array(14);
  const dv = new DataView(headerData.buffer);
  headerData[0] = 0x4d; headerData[1] = 0x54; headerData[2] = 0x68; headerData[3] = 0x64; // "MThd"
  dv.setUint32(4, 6, false);
  dv.setUint16(8, 1, false); // format 1
  dv.setUint16(10, tracks.length, false);
  dv.setUint16(12, TICKS_PER_QUARTER, false);

  const trackBytes = tracks.map((t) => t.toBytes());
  const totalLen = headerData.length + trackBytes.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  out.set(headerData, offset); offset += headerData.length;
  trackBytes.forEach((tb) => { out.set(tb, offset); offset += tb.length; });
  return out;
}


/* =========================================================
   Workerメッセージハンドラ
   ========================================================= */

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  if (type === 'analyze') {
    try {
      const { audioData, mode, params } = payload;
      // メインスレッドからは AudioBuffer をそのまま送れないため、
      // { sampleRate, duration, numberOfChannels, length, channelData: [Float32Array,...] }
      // という形で受け取り、analyzeAudio が期待する最低限のインターフェースに変換する。
      const audioBufferLike = {
        sampleRate: audioData.sampleRate,
        duration: audioData.duration,
        numberOfChannels: audioData.numberOfChannels,
        length: audioData.length,
        getChannelData: (ch) => audioData.channelData[ch]
      };

      const onProgress = (fraction, text) => {
        self.postMessage({ type: 'progress', payload: { fraction, text } });
      };

      const analysis = await analyzeAudio(audioBufferLike, mode, params, onProgress);
      const midiBytes = buildMidiFile(analysis, params);

      // ---------------------------------------------------------
      // メインスレッドへ返す可視化用データを軽量化する。
      //
      // 以前はフレームごとに個別のFloat32Array（mag, noteEnergies）を
      // 持たせていたが、これだと長い曲では数千個のオブジェクトを
      // 生成することになり、Worker→メインスレッドの転送コストが
      // 非常に大きくなっていた（環境によっては転送に失敗したり、
      // 極端に遅くなる原因になっていた）。
      //
      // 対策として:
      //   1. 可視化に使う分だけフレームを間引く（最大400点程度で十分）
      //   2. mag / noteEnergies は「全フレーム分をまとめた1本の
      //      Float32Array」として持たせ、個別オブジェクトの生成数を
      //      1個に抑える（フラット化）
      // ---------------------------------------------------------
      const MAX_VIZ_FRAMES = 400;
      const totalFrames = analysis.frames.length;
      const vizStep = Math.max(1, Math.ceil(totalFrames / MAX_VIZ_FRAMES));
      const vizFrameIndices = [];
      for (let i = 0; i < totalFrames; i += vizStep) vizFrameIndices.push(i);

      const magLen = analysis.frames.find((f) => f.mag)?.mag.length || 0;
      const noteEnergiesLen = analysis.frames.find((f) => f.noteEnergies)?.noteEnergies.length || 0;

      const vizCount = vizFrameIndices.length;
      const magFlat = magLen ? new Float32Array(vizCount * magLen) : null;
      const noteEnergiesFlat = noteEnergiesLen ? new Float32Array(vizCount * noteEnergiesLen) : null;

      const framesLite = vizFrameIndices.map((idx, i) => {
        const f = analysis.frames[idx];
        if (magFlat && f.mag) magFlat.set(f.mag, i * magLen);
        if (noteEnergiesFlat && f.noteEnergies) noteEnergiesFlat.set(f.noteEnergies, i * noteEnergiesLen);
        return {
          t: f.t, amp: f.amp, db: f.db, isSilent: f.isSilent,
          centroid: f.centroid, zcr: f.zcr,
          hasNoteEnergies: !!f.noteEnergies
        };
      });

      const result = {
        mode: analysis.mode,
        resolvedMode: analysis.resolvedMode,
        scan: analysis.scan,
        sampleRate: analysis.sampleRate,
        duration: analysis.duration,
        frameMs: analysis.frameMs,
        hopMs: analysis.hopMs,
        frameSize: analysis.frameSize,
        hopSize: analysis.hopSize,
        frames: framesLite,
        magLen, noteEnergiesLen,
        magFlat, noteEnergiesFlat,
        events: analysis.events,
        notes: analysis.notes,
        waveformPeaks: analysis.waveformPeaks,
        midiBytes
      };

      // Transferableオブジェクト(ArrayBuffer)は転送するとコピーコストがかからず高速。
      // フラット化したことで、ここで転送するArrayBufferは
      // 「MIDIバイナリ」「mag全体」「noteEnergies全体」の3個だけになる
      // (以前はフレーム数×2個、数千個になり得ていた)。
      const transferList = [midiBytes.buffer];
      if (magFlat) transferList.push(magFlat.buffer);
      if (noteEnergiesFlat) transferList.push(noteEnergiesFlat.buffer);

      self.postMessage({ type: 'done', payload: result }, transferList);
    } catch (err) {
      self.postMessage({ type: 'error', payload: { message: err.message, stack: err.stack } });
    }
  }
};
