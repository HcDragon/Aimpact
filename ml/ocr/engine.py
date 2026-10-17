"""OCR engines behind one interface: read(Prepared) -> list[Word].

EasyOCR is the default. TesseractEngine is a stub kept for when the tesseract
binary is installed (pytesseract alone is only a wrapper).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np

from ocr.preprocess import Prepared
from settings import ml_path

NUMERIC_ALLOWLIST = "0123456789.,%/-"
_NUMERICISH = re.compile(r"^[\dOoIlSBZ.,%/₹\-]+$")


@dataclass
class Word:
    text: str
    conf: float
    x0: float
    y0: float
    x1: float
    y1: float
    source: str = "gray"   # gray | binary | reread

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2

    @property
    def h(self) -> float:
        return self.y1 - self.y0

    def as_dict(self) -> dict:
        return {"text": self.text, "conf": round(self.conf, 3),
                "box": [round(self.x0), round(self.y0), round(self.x1), round(self.y1)], "source": self.source}


def iou(a: Word, b: Word) -> float:
    ix = max(0.0, min(a.x1, b.x1) - max(a.x0, b.x0))
    iy = max(0.0, min(a.y1, b.y1) - max(a.y0, b.y0))
    inter = ix * iy
    union = (a.x1 - a.x0) * a.h + (b.x1 - b.x0) * b.h - inter
    return inter / union if union > 0 else 0.0


def merge_passes(primary: list[Word], secondary: list[Word], thr: float = 0.5) -> list[Word]:
    """Per overlapping box keep the more confident read; keep boxes only one pass found."""
    out, used = [], set()
    for w in primary:
        best_j, best = None, thr
        for j, s in enumerate(secondary):
            if j not in used and (o := iou(w, s)) >= best:
                best_j, best = j, o
        if best_j is not None:
            used.add(best_j)
            s = secondary[best_j]
            out.append(s if s.conf > w.conf else w)
        else:
            out.append(w)
    # Unmatched second-pass boxes are kept only if they are new text, not a fragment of a kept box.
    for j, s in enumerate(secondary):
        if j in used or s.conf < 0.5:
            continue
        area = max(1e-6, (s.x1 - s.x0) * s.h)
        inside = max((max(0.0, min(s.x1, w.x1) - max(s.x0, w.x0)) * max(0.0, min(s.y1, w.y1) - max(s.y0, w.y0)) / area
                      for w in out), default=0.0)
        if inside < 0.5:
            out.append(s)
    return out


def _device(use_gpu: bool):
    if not use_gpu:
        return False
    import torch
    if torch.cuda.is_available():
        return True
    if torch.backends.mps.is_available():
        return "mps"
    return False


@lru_cache(maxsize=4)
def _reader(languages: tuple[str, ...], use_gpu: bool, model_dir: str):
    import easyocr

    try:
        return easyocr.Reader(list(languages), gpu=_device(use_gpu), model_storage_directory=model_dir, verbose=False)
    except Exception:  # some torch builds fail on MPS; CPU always works
        return easyocr.Reader(list(languages), gpu=False, model_storage_directory=model_dir, verbose=False)


class EasyOCREngine:
    name = "easyocr"

    def __init__(self, cfg: dict):
        self.cfg = cfg["ocr"]
        model_dir = ml_path(self.cfg["model_dir"])
        model_dir.mkdir(parents=True, exist_ok=True)
        self.reader = _reader(tuple(self.cfg["languages"]), bool(self.cfg["use_gpu"]), str(model_dir))

    def _readtext(self, img: np.ndarray, source: str, **overrides) -> list[Word]:
        rt = self.cfg["readtext"]
        params = dict(decoder=rt["decoder"], beamWidth=rt["beam_width"], text_threshold=rt["text_threshold"],
                      low_text=rt["low_text"], link_threshold=rt["link_threshold"], width_ths=rt["width_ths"],
                      contrast_ths=rt["contrast_ths"], adjust_contrast=rt["adjust_contrast"],
                      mag_ratio=rt["mag_ratio"], canvas_size=rt["canvas_size"], add_margin=rt["add_margin"],
                      paragraph=False, detail=1)
        params.update(overrides)
        words = []
        for box, text, conf in self.reader.readtext(img, **params):
            xs, ys = [p[0] for p in box], [p[1] for p in box]
            if text.strip():
                words.append(Word(text.strip(), float(conf), min(xs), min(ys), max(xs), max(ys), source))
        return words

    def _reread_numeric(self, img: np.ndarray, w: Word) -> Word:
        """Crop a low-confidence number, upscale it, and read it again with digits only."""
        pad = max(2, int(w.h * 0.25))
        y0, y1 = max(0, int(w.y0) - pad), min(img.shape[0], int(w.y1) + pad)
        x0, x1 = max(0, int(w.x0) - pad), min(img.shape[1], int(w.x1) + pad)
        crop = img[y0:y1, x0:x1]
        if crop.size == 0:
            return w
        s = self.cfg["reread_scale"]
        crop = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
        crop = cv2.copyMakeBorder(crop, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)
        hits = self._readtext(crop, "reread", allowlist=NUMERIC_ALLOWLIST, width_ths=1.0, mag_ratio=1.0)
        if not hits:
            return w
        text = "".join(h.text for h in sorted(hits, key=lambda h: h.x0))
        conf = float(np.mean([h.conf for h in hits]))
        return Word(text, conf, w.x0, w.y0, w.x1, w.y1, "reread") if conf > w.conf else w

    def read_region(self, img: np.ndarray, x0: float, y0: float, x1: float, y1: float,
                    allowlist: str | None = None, scale: float = 2.0) -> list[Word]:
        """Re-read one region (e.g. a labelled line) as a single text run."""
        y0, y1 = max(0, int(y0)), min(img.shape[0], int(y1))
        x0, x1 = max(0, int(x0)), min(img.shape[1], int(x1))
        crop = img[y0:y1, x0:x1]
        if crop.size == 0:
            return []
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        crop = cv2.copyMakeBorder(crop, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)
        hits = self._readtext(crop, "reread", allowlist=allowlist, width_ths=2.0, add_margin=0.2)
        return [Word(w.text, w.conf, x0 + (w.x0 - 12) / scale, y0 + (w.y0 - 12) / scale,
                     x0 + (w.x1 - 12) / scale, y0 + (w.y1 - 12) / scale, "reread") for w in hits]

    def read(self, prepared: Prepared) -> list[Word]:
        words = self._readtext(prepared.gray, "gray")
        if self.cfg["second_pass_binarized"]:
            words = merge_passes(words, self._readtext(prepared.binary, "binary"))
        thr = self.cfg["reread_numeric_below"]
        return [self._reread_numeric(prepared.gray, w)
                if w.conf < thr and _NUMERICISH.match(w.text.replace(" ", "")) and any(c.isdigit() for c in w.text)
                else w for w in words]


class TesseractEngine:
    name = "tesseract"

    def __init__(self, cfg: dict):
        import shutil
        if not shutil.which("tesseract"):
            raise RuntimeError("tesseract binary not installed (brew install tesseract)")
        self.cfg = cfg["ocr"]

    def read(self, prepared: Prepared) -> list[Word]:
        import pytesseract

        data = pytesseract.image_to_data(prepared.gray, config="--oem 1 --psm 6",
                                         output_type=pytesseract.Output.DICT)
        return [Word(t, float(c) / 100, x, y, x + w, y + h)
                for t, c, x, y, w, h in zip(data["text"], data["conf"], data["left"], data["top"],
                                            data["width"], data["height"]) if t.strip() and float(c) >= 0]


def get_engine(cfg: dict, name: str | None = None):
    name = name or cfg["ocr"]["engine"]
    return {"easyocr": EasyOCREngine, "tesseract": TesseractEngine}[name](cfg)
