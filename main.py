import asyncio
import json
import math
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from audio_capture import capture

app = FastAPI(title="Audio Equalizer")
app.mount("/static", StaticFiles(directory="static"), name="static")

SETTINGS_FILE = Path("equalizer_settings.json")


def build_band_centers_hz(
    bands: int,
    sample_rate: int,
    min_f: float = 20.0,
    max_f: float = 20000.0,
) -> list[float]:
    nyquist = sample_rate / 2.0
    max_f = min(max_f, nyquist - 1.0)
    if bands <= 0 or max_f <= min_f:
        return []
    edges = [
        10 ** (math.log10(min_f) + i * (math.log10(max_f) - math.log10(min_f)) / bands)
        for i in range(bands + 1)
    ]
    return [math.sqrt(edges[i] * edges[i + 1]) for i in range(bands)]


def normalize_band_gains(raw, bands: int) -> list[float]:
    default = [1.0] * bands
    if not isinstance(raw, list):
        return default
    out = []
    for v in raw[:bands]:
        try:
            fv = float(v)
        except Exception:
            fv = 1.0
        out.append(max(0.0, min(fv, 4.0)))  # 0..4x
    if len(out) < bands:
        out.extend([1.0] * (bands - len(out)))
    return out


def save_equalizer_styles_to_file(styles: dict) -> None:
    try:
        SETTINGS_FILE.write_text(
            json.dumps(styles, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


def load_equalizer_styles_from_file(default_styles: dict, bands: int, sample_rate: int) -> dict:
    if not SETTINGS_FILE.exists():
        return default_styles
    try:
        raw = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
        loaded = raw if isinstance(raw, dict) else {}
        merged = {**default_styles, **loaded}
        merged["bandGains"] = normalize_band_gains(merged.get("bandGains"), bands)
        if not isinstance(merged.get("bandCentersHz"), list) or len(merged["bandCentersHz"]) != bands:
            merged["bandCentersHz"] = build_band_centers_hz(bands, sample_rate)
        return merged
    except Exception:
        return default_styles


class State:
    bands = int(getattr(capture, "BANDS", 64))
    sample_rate = int(getattr(capture, "SAMPLE_RATE", 48000))

    spectrum = [0.0] * bands
    source = "server"  # 'server' (системный) или 'browser'
    eq_styles = {
        "colorTop": "#e94560",
        "colorBottom": "#533483",
        "rainbow": False,
        "bgColor": "#0a0a14",
        "transparent": False,
        "bgAlpha": 1.0,
        "sensitivity": 1.0,
        "bandGains": [1.0] * bands,
        "bandCentersHz": build_band_centers_hz(bands, sample_rate),
    }


state = State()
state.eq_styles = load_equalizer_styles_from_file(state.eq_styles, state.bands, state.sample_rate)


@app.get("/")
async def index():
    return FileResponse("static/capture/capture.html")


@app.get("/equalizer")
async def equalizer_page():
    return FileResponse("static/equalizer/equalizer.html")


@app.get("/api/devices")
async def get_devices():
    return {"devices": capture.list_devices()}


@app.get("/api/equalizer/styles")
async def get_equalizer_styles():
    return {"settings": state.eq_styles}


@app.post("/api/equalizer/styles")
async def set_equalizer_styles(payload: dict):
    if isinstance(payload, dict):
        merged = {**state.eq_styles, **payload}
        merged["bandGains"] = normalize_band_gains(merged.get("bandGains"), state.bands)
        if not isinstance(merged.get("bandCentersHz"), list) or len(merged["bandCentersHz"]) != state.bands:
            merged["bandCentersHz"] = build_band_centers_hz(state.bands, state.sample_rate)
        state.eq_styles = merged
        save_equalizer_styles_to_file(state.eq_styles)
    return {"status": "ok", "settings": state.eq_styles}


@app.post("/api/start")
async def start_capture(payload: dict):
    source_type = payload.get("source_type", "system")
    state.source = "server" if source_type == "system" else "browser"
    if source_type == "system":
        device_id = payload.get("device_id")
        capture.start(source_type="system", device_id=device_id)
    else:
        capture.stop()
    return {"status": "started", "source": state.source}


@app.post("/api/stop")
async def stop_capture():
    capture.stop()
    state.spectrum = [0.0] * state.bands
    return {"status": "stopped"}


@app.websocket("/ws/ingest")
async def ws_ingest(websocket: WebSocket):
    """Приём спектра от страницы захвата (браузерный режим)."""
    await websocket.accept()
    state.source = "browser"
    try:
        while True:
            data = await websocket.receive_text()
            state.spectrum = json.loads(data)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass


@app.websocket("/ws/equalizer")
async def ws_equalizer(websocket: WebSocket):
    """Отдача спектра эквалайзеру."""
    await websocket.accept()
    try:
        while True:
            if state.source == "server":
                spec = await asyncio.to_thread(capture.get_spectrum, 0.03)
                if spec is not None:
                    state.spectrum = spec
            await websocket.send_text(json.dumps(state.spectrum))
            await asyncio.sleep(0.016)  # ~60 fps
    except WebSocketDisconnect:
        pass
    except Exception:
        pass


@app.on_event("shutdown")
def shutdown():
    capture.stop()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)