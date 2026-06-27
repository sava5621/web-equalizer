// equalizer.js
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const defaultSettings = {
    colorTop: '#e94560',
    colorBottom: '#533483',
    rainbow: false,
    bgColor: '#0a0a14',
    transparent: false,
    bgAlpha: 1.0,
    sensitivity: 1.0
};

let settings = { ...defaultSettings };

function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function applyBodyBg() {
    if (settings.transparent) {
        document.documentElement.style.background = 'transparent';
        document.body.style.background = 'transparent';
    } else {
        const [r, g, b] = hexToRgb(settings.bgColor);
        document.body.style.background = `rgba(${r},${g},${b},${settings.bgAlpha})`;
    }
}

async function requestSettingsFromServer() {
    try {
        const resp = await fetch('/api/equalizer/styles', { cache: 'no-store' });
        if (!resp.ok) return {};
        const data = await resp.json();
        return (data && typeof data === 'object' && data.settings) ? data.settings : {};
    } catch (_) {
        return {};
    }
}

async function refreshSettingsFromServer() {
    const serverSettings = await requestSettingsFromServer();
    settings = { ...settings, ...serverSettings };
    applyBodyBg();
}

async function loadInitialSettings() {
    const serverSettings = await requestSettingsFromServer();
    settings = { ...defaultSettings, ...serverSettings };
    applyBodyBg();
}

function resize() {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
}

addEventListener('resize', resize);

let spectrum = new Array(64).fill(0);
let smoothed = new Array(64).fill(0);

function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/equalizer`);

    ws.onclose = () => setTimeout(connect, 1000);

    ws.onmessage = (e) => {
        const data = JSON.parse(e.data);
        if (Array.isArray(data) && data.length) {
            spectrum = data;
        }
    };
}

function draw() {
    const w = canvas.width;
    const h = canvas.height;

    if (settings.transparent) {
        ctx.clearRect(0, 0, w, h);
    } else {
        const [r, g, b] = hexToRgb(settings.bgColor);
        if (settings.bgAlpha >= 1) {
            ctx.fillStyle = `rgba(${r},${g},${b},0.3)`;
            ctx.fillRect(0, 0, w, h);
        } else {
            ctx.clearRect(0, 0, w, h);
            ctx.fillStyle = `rgba(${r},${g},${b},${settings.bgAlpha})`;
            ctx.fillRect(0, 0, w, h);
        }
    }

    const n = spectrum.length;
    if (smoothed.length !== n) {
        smoothed = new Array(n).fill(0);
    }

    const bw = w / n;

    for (let i = 0; i < n; i++) {
        const val = Math.min(spectrum[i] * settings.sensitivity, 1.0);
        smoothed[i] += (val - smoothed[i]) * 0.4;
        const barH = smoothed[i] * h * 0.9;

        let grad;
        if (settings.rainbow) {
            const hue = (i / n) * 280;
            grad = ctx.createLinearGradient(0, h - barH, 0, h);
            grad.addColorStop(0, `hsl(${hue}, 90%, 65%)`);
            grad.addColorStop(1, `hsl(${hue}, 90%, 35%)`);
        } else {
            grad = ctx.createLinearGradient(0, h - barH, 0, h);
            grad.addColorStop(0, settings.colorTop);
            grad.addColorStop(1, settings.colorBottom);
        }

        ctx.fillStyle = grad;
        ctx.fillRect(i * bw + 1, h - barH, bw - 2, barH);
    }

    requestAnimationFrame(draw);
}

async function init() {
    await loadInitialSettings();
    setInterval(refreshSettingsFromServer, 500);
    resize();
    document.body.style.visibility = 'visible';
    connect();
    requestAnimationFrame(draw);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        init();
    });
} else {
    init();
}