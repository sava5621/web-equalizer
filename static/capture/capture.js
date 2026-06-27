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
    } catch (e) {}
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
        headers: {'Content-Type': 'application/json'},
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
                autoGainControl: false,
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
    const minF = 20, maxF = 20000;
    const result = new Array(BANDS).fill(0);

    for (let i = 0; i < BANDS; i++) {
        const f1 = minF * Math.pow(maxF / minF, i / BANDS);
        const f2 = minF * Math.pow(maxF / minF, (i + 1) / BANDS);
        const bin1 = Math.floor(f1 / nyquist * binCount);
        const bin2 = Math.max(bin1 + 1, Math.floor(f2 / nyquist * binCount));
        let sum = 0, cnt = 0;
        for (let b = bin1; b < bin2 && b < binCount; b++) {
            sum += freqData[b]; cnt++;
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
    if (ingestWs) { ingestWs.close(); ingestWs = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    analyser = null;
    if (captureStream) {
        captureStream.getTracks().forEach(t => t.stop());
        captureStream = null;
    }
}

async function stop() {
    stopBrowserCapture();
    try { await fetch('/api/stop', { method: 'POST' }); } catch (e) {}
    status.textContent = '⏹ Захват остановлен';
}

function saveSettings() {
    const settings = {
        colorTop: document.getElementById('colorTop').value,
        colorBottom: document.getElementById('colorBottom').value,
        rainbow: document.getElementById('rainbow').checked,
        bgColor: document.getElementById('bgColor').value,
        transparent: document.getElementById('transparent').checked,
        bgAlpha: document.getElementById('bgAlpha').value / 100,
        sensitivity: document.getElementById('sensitivity').value / 100,
    };
    localStorage.setItem('eqSettings', JSON.stringify(settings));
    status.textContent = '🎨 Настройки сохранены и применены к эквалайзеру';
}

function loadSavedSettings() {
    const s = JSON.parse(localStorage.getItem('eqSettings') || '{}');
    if (s.colorTop) document.getElementById('colorTop').value = s.colorTop;
    if (s.colorBottom) document.getElementById('colorBottom').value = s.colorBottom;
    if (s.rainbow !== undefined) document.getElementById('rainbow').checked = s.rainbow;
    if (s.bgColor) document.getElementById('bgColor').value = s.bgColor;
    if (s.transparent !== undefined) document.getElementById('transparent').checked = s.transparent;
    if (s.bgAlpha !== undefined) document.getElementById('bgAlpha').value = s.bgAlpha * 100;
    if (s.sensitivity !== undefined) {
        document.getElementById('sensitivity').value = s.sensitivity * 100;
        document.getElementById('sensVal').textContent = Math.round(s.sensitivity * 100);
    }
}

// Живое обновление чувствительности
const sensSlider = document.getElementById('sensitivity');
sensSlider.addEventListener('input', () => {
    document.getElementById('sensVal').textContent = sensSlider.value;
    const s = JSON.parse(localStorage.getItem('eqSettings') || '{}');
    s.sensitivity = sensSlider.value / 100;
    localStorage.setItem('eqSettings', JSON.stringify(s));
});

loadDevices();
loadSavedSettings();
window.addEventListener('beforeunload', stopBrowserCapture);