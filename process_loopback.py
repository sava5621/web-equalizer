"""
Захват звука конкретного процесса (Windows 10 2004+).
Использует WASAPI Process Loopback через PyAudioWPatch (рекомендуется),
либо fallback.

pip install PyAudioWPatch
"""
import numpy as np


class ProcessLoopbackRecorder:
    """
    Упрощённый захват per-process loopback.
    На практике надёжнее всего работает через PyAudioWPatch,
    но он не поддерживает per-process из коробки.

    Поэтому здесь делаем честный fallback: захватываем системный
    loopback (звук всего ПК). Для истинного per-process нужен
    нативный код WASAPI AUDIOCLIENT_ACTIVATION_PARAMS.
    """
    def __init__(self, pid, samplerate, blocksize):
        self.pid = pid
        self.samplerate = samplerate
        self.blocksize = blocksize
        self._rec = None
        self._ctx = None

    def start(self):
        import soundcard as sc
        mic = sc.get_microphone(str(sc.default_speaker().name),
                                include_loopback=True)
        self._ctx = mic.recorder(samplerate=self.samplerate,
                                  blocksize=self.blocksize)
        self._rec = self._ctx.__enter__()

    def read(self, frames):
        if self._rec:
            return self._rec.record(numframes=frames)
        return None

    def stop(self):
        if self._ctx:
            try:
                self._ctx.__exit__(None, None, None)
            except Exception:
                pass
        self._ctx = None
        self._rec = None