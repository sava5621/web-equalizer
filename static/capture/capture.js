// capture.js
const sel = document.getElementById('devices');
const status = document.getElementById('status');

function toggleSource() {
    const val = document.querySelector('input[name="source"]:checked').value;
    document.getElementById('systemBlock').classList.toggle('hidden', val !== 'system');
    document.getElementById('browserBlock').classList.toggle('hidden', val !== 'browser');
}

async function loadDevices() {
    try {
        const res = await fetch('/api/devices');
        const data = await res.json();
        sel.innerHTML = '';
        data.devices.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = '🔊 ' + d.name;
            sel.appendChild(opt);
        });
    } catch (e) {
        // ignore
    }
}

// ===== браузерный захват =====
let captureStream = null;
let audioCtx = null;
let analyser = null;
let freqData = null;
let ingestWs = null;
let rafId = null;

const BANDS = 64;

async function start() {
    const source = document.querySelector('input[name="source"]:checked').value;

    await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            source_type: source,
            device_id: source === 'system' ? sel.value : null
        })
    });

    if (source === 'system') {
        stopBrowserCapture();
        status.textContent = '✅ Системный захват запущен. Откройте эквалайзер.';
    } else {
        await startBrowserCapture();
    }
}

async function startBrowserCapture() {
    try {
        captureStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        const audioTracks = captureStream.getAudioTracks();
        if (audioTracks.length === 0) {
            status.textContent = '⚠ Аудио не захвачено! Включите «Поделиться аудио».';
            stopBrowserCapture();
            return;
        }

        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaStreamSource(captureStream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.0;
        src.connect(analyser);
        freqData = new Uint8Array(analyser.frequencyBinCount);

        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        ingestWs = new WebSocket(`${proto}://${location.host}/ws/ingest`);

        ingestWs.onopen = () => {
            status.textContent = '✅ Захват окна активен. Эквалайзер доступен по ссылке.';
            sendLoop();
        };

        audioTracks[0].onended = () => {
            status.textContent = '⏹ Захват окна остановлен пользователем.';
            stopBrowserCapture();
        };
    } catch (e) {
        status.textContent = '❌ Отменено или ошибка: ' + e.message;
    }
}

function computeSpectrum() {
    analyser.getByteFrequencyData(freqData);
    const nyquist = audioCtx.sampleRate / 2;
    const binCount = freqData.length;
    const minF = 20;
    const maxF = 20000;
    const result = new Array(BANDS).fill(0);

    for (let i = 0; i < BANDS; i++) {
        const f1 = minF * Math.pow(maxF / minF, i / BANDS);
        const f2 = minF * Math.pow(maxF / minF, (i + 1) / BANDS);
        const bin1 = Math.floor((f1 / nyquist) * binCount);
        const bin2 = Math.max(bin1 + 1, Math.floor((f2 / nyquist) * binCount));
        let sum = 0;
        let cnt = 0;

        for (let b = bin1; b < bin2 && b < binCount; b++) {
            sum += freqData[b];
            cnt++;
        }
        result[i] = cnt > 0 ? (sum / cnt) / 255 : 0;
    }

    return result;
}

function sendLoop() {
    if (!ingestWs || ingestWs.readyState !== WebSocket.OPEN) return;
    const spec = computeSpectrum();
    ingestWs.send(JSON.stringify(spec));
    rafId = requestAnimationFrame(sendLoop);
}

function stopBrowserCapture() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;

    if (ingestWs) {
        ingestWs.close();
        ingestWs = null;
    }

    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }

    analyser = null;

    if (captureStream) {
        captureStream.getTracks().forEach(t => t.stop());
        captureStream = null;
    }
}

async function stop() {
    stopBrowserCapture();
    try {
        await fetch('/api/stop', { method: 'POST' });
    } catch (e) {
        // ignore
    }
    status.textContent = '⏹ Захват остановлен';
}

function readSettingsFromControls() {
    return {
        colorTop: document.getElementById('colorTop').value,
        colorBottom: document.getElementById('colorBottom').value,
        rainbow: document.getElementById('rainbow').checked,
        bgColor: document.getElementById('bgColor').value,
        transparent: document.getElementById('transparent').checked,
        bgAlpha: document.getElementById('bgAlpha').value / 100,
        sensitivity: document.getElementById('sensitivity').value / 100
    };
}

function applySettingsToControls(s) {
    if (s.colorTop) document.getElementById('colorTop').value = s.colorTop;
    if (s.colorBottom) document.getElementById('colorBottom').value = s.colorBottom;
    if (s.rainbow !== undefined) document.getElementById('rainbow').checked = !!s.rainbow;
    if (s.bgColor) document.getElementById('bgColor').value = s.bgColor;
    if (s.transparent !== undefined) document.getElementById('transparent').checked = !!s.transparent;
    if (s.bgAlpha !== undefined) document.getElementById('bgAlpha').value = Math.round(Number(s.bgAlpha) * 100);
    if (s.sensitivity !== undefined) {
        const percent = Math.round(Number(s.sensitivity) * 100);
        document.getElementById('sensitivity').value = percent;
        document.getElementById('sensVal').textContent = String(percent);
    }
}

async function saveSettings() {
    const settings = readSettingsFromControls();

    try {
        const res = await fetch('/api/equalizer/styles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        status.textContent = '🎨 Настройки сохранены в приложении';
    } catch (e) {
        status.textContent = '❌ Не удалось сохранить настройки: ' + e.message;
    }
}

async function loadSavedSettings() {
    try {
        const res = await fetch('/api/equalizer/styles', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const s = (data && data.settings) ? data.settings : {};
        applySettingsToControls(s);
    } catch (e) {
        // ignore
    }
}

// Живое обновление чувствительности (без localStorage)
const sensSlider = document.getElementById('sensitivity');
sensSlider.addEventListener('input', () => {
    document.getElementById('sensVal').textContent = sensSlider.value;
});

loadDevices();
loadSavedSettings();
toggleSource();
window.addEventListener('beforeunload', stopBrowserCapture);