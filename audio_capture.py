import warnings
import soundcard as sc
import numpy as np
import threading
import queue

# Подавляем предупреждение о разрывах данных
try:
    from soundcard.mediafoundation import SoundcardRuntimeWarning
    warnings.filterwarnings("ignore", category=SoundcardRuntimeWarning)
except Exception:
    warnings.filterwarnings("ignore", message="data discontinuity in recording")


class AudioCapture:
    """Захват системного звука (loopback) с устройства вывода."""

    SAMPLE_RATE = 48000
    BLOCK_SIZE = 2048  # увеличен для лучшего разрешения по низким частотам
    BANDS = 64

    # Параметры адаптивной нормализации
    MIN_DB_SPAN = 12.0
    HEADROOM = 0.92
    SILENCE_DBFS = -58.0
    SILENCE_DECAY = 0.86
    NOISE_GATE_DB = 3.0

    def __init__(self):
        self._thread = None
        self._running = False
        self._queue = queue.Queue(maxsize=4)
        self._device_id = None

        # EMA-оценки "пола" и "потолка" спектра в dB
        self._db_floor_ema = -85.0
        self._db_ceil_ema = -25.0
        self._last_spectrum = np.zeros(self.BANDS, dtype=np.float32)

    @staticmethod
    def list_devices():
        """Список loopback-устройств (звук всей системы)."""
        devices = []
        try:
            for mic in sc.all_microphones(include_loopback=True):
                if mic.isloopback:
                    devices.append({"id": mic.id, "name": mic.name})
        except Exception as e:
            print(f"list_devices error: {e}")
        return devices

    def start(self, source_type: str = "system", device_id: str | None = None):
        if self._running:
            self.stop()

        # в браузерном режиме сервер не захватывает звук
        if source_type != "system":
            return

        self._device_id = device_id
        self._running = True
        self._thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=1.5)
            self._thread = None
        with self._queue.mutex:
            self._queue.queue.clear()

    def _get_mic(self):
        if self._device_id:
            try:
                return sc.get_microphone(self._device_id, include_loopback=True)
            except Exception:
                pass
        return sc.get_microphone(
            str(sc.default_speaker().name), include_loopback=True
        )

    def _capture_loop(self):
        mic = self._get_mic()
        try:
            with mic.recorder(samplerate=self.SAMPLE_RATE,
                              blocksize=self.BLOCK_SIZE) as rec:
                while self._running:
                    data = rec.record(numframes=self.BLOCK_SIZE)
                    self._process(data)
        except Exception as e:
            print(f"Capture error: {e}")

    def _process(self, data: np.ndarray):
        if data.ndim > 1:
            data = data.mean(axis=1)
        spectrum = self._compute_spectrum(data)
        if self._queue.full():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
        self._queue.put(spectrum)

    def _compute_spectrum(self, samples: np.ndarray):
        n = len(samples)
        if n == 0:
            return [0.0] * self.BANDS

        # Детектор тишины по RMS: в тишине плавно гасим столбики
        rms = float(np.sqrt(np.mean(samples * samples) + 1e-12))
        dbfs = 20.0 * np.log10(rms + 1e-12)
        if dbfs < self.SILENCE_DBFS:
            self._last_spectrum *= self.SILENCE_DECAY
            self._last_spectrum = np.clip(self._last_spectrum, 0.0, self.HEADROOM)
            return self._last_spectrum.tolist()

        windowed = samples * np.hanning(n)
        fft = np.abs(np.fft.rfft(windowed))
        freqs = np.fft.rfftfreq(n, 1.0 / self.SAMPLE_RATE)

        min_f = 20.0
        max_f = min(20000.0, self.SAMPLE_RATE / 2 - 1.0)

        # Логарифмические границы и центры полос (геометрический центр)
        edges = np.logspace(np.log10(min_f), np.log10(max_f), self.BANDS + 1)
        centers = np.sqrt(edges[:-1] * edges[1:])

        # Исключаем DC-компонент (0 Гц), чтобы не тянуть график в нули/перекос
        valid = freqs > 0
        if not np.any(valid):
            return [0.0] * self.BANDS

        # Переход в dB
        fft_db = 20 * np.log10(fft[valid] + 1e-9)

        # Интерполяция на центры полос — устраняет "дырки" с нулевыми колонками
        band_db = np.interp(
            centers,
            freqs[valid],
            fft_db,
            left=fft_db[0],
            right=fft_db[-1],
        )

        # Лёгкое сглаживание по соседним полосам
        kernel = np.array([0.2, 0.6, 0.2])
        band_db = np.convolve(band_db, kernel, mode="same")

        # Адаптивная нормализация + шумовой порог
        result = self._adaptive_normalize(band_db)

        # Прижимаем крайние полосы к соседним, чтобы края не "стреляли" в тишине
        if len(result) >= 3:
            result[0] = 0.35 * result[0] + 0.65 * result[1]
            result[-1] = 0.35 * result[-1] + 0.65 * result[-2]

        self._last_spectrum = result.astype(np.float32)
        return result.tolist()

    def _adaptive_normalize(self, band_db: np.ndarray) -> np.ndarray:
        # Перцентильная оценка текущего "пола" и "потолка"
        frame_floor = float(np.percentile(band_db, 10))
        frame_ceil = float(np.percentile(band_db, 95))

        # Быстро реагируем на рост, медленнее отпускаем вниз (для стабильности)
        a_up, a_down = 0.25, 0.04

        af = a_up if frame_floor < self._db_floor_ema else a_down
        ac = a_up if frame_ceil > self._db_ceil_ema else a_down

        self._db_floor_ema = (1.0 - af) * self._db_floor_ema + af * frame_floor
        self._db_ceil_ema = (1.0 - ac) * self._db_ceil_ema + ac * frame_ceil

        # Гарантируем минимальный рабочий диапазон
        if self._db_ceil_ema - self._db_floor_ema < self.MIN_DB_SPAN:
            self._db_ceil_ema = self._db_floor_ema + self.MIN_DB_SPAN

        x = (band_db - self._db_floor_ema) / (self._db_ceil_ema - self._db_floor_ema)
        x = np.clip(x, 0.0, 1.0)

        # Шумовой порог относительно динамического пола
        noise_floor = self._db_floor_ema + self.NOISE_GATE_DB
        x = np.where(band_db > noise_floor, x, 0.0)

        # Мягкая компрессия пиков + запас до потолка
        x = 1.0 - np.exp(-2.2 * x)
        x = np.clip(x * self.HEADROOM, 0.0, self.HEADROOM)

        return x

    def get_spectrum(self, timeout: float = 0.1):
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None


capture = AudioCapture()