import asyncio
import json

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from audio_capture import capture

app = FastAPI(title="Audio Equalizer")
app.mount("/static", StaticFiles(directory="static"), name="static")


class State:
    spectrum = [0.0] * 64
    source = "server"  # 'server' (системный) или 'browser'


state = State()


@app.get("/")
async def index():
    return FileResponse("static/capture.html")


@app.get("/equalizer")
async def equalizer_page():
    return FileResponse("static/equalizer.html")


@app.get("/api/devices")
async def get_devices():
    return {"devices": capture.list_devices()}


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
    state.spectrum = [0.0] * 64
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