"""Image clean-up before OCR: crop to the paper, flatten, resize, deskew, denoise, contrast.

Phone photos of bills are the norm: tilted, lit unevenly, with the table or
counter around the paper. Each step is optional via config.ocr.preprocess.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Prepared:
    gray: np.ndarray                 # main OCR input
    binary: np.ndarray               # adaptive-threshold copy for the second pass
    steps: list[str] = field(default_factory=list)
    skew_degrees: float = 0.0


def load_image(source: str | bytes | np.ndarray) -> np.ndarray:
    if isinstance(source, np.ndarray):
        return source
    if isinstance(source, (bytes, bytearray)):
        img = cv2.imdecode(np.frombuffer(source, np.uint8), cv2.IMREAD_COLOR)
    else:
        img = cv2.imread(str(source), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    return img


def _order_corners(pts: np.ndarray) -> np.ndarray:
    s, d = pts.sum(axis=1), np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], dtype=np.float32)


def perspective_crop(img: np.ndarray) -> np.ndarray | None:
    """Flatten the largest 4-cornered contour if it covers most of the frame (the paper)."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    small_scale = 800 / max(gray.shape)
    small = cv2.resize(gray, None, fx=small_scale, fy=small_scale) if small_scale < 1 else gray
    scale = small_scale if small_scale < 1 else 1.0
    edges = cv2.Canny(cv2.GaussianBlur(small, (5, 5), 0), 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area = small.shape[0] * small.shape[1]
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
        if len(approx) == 4 and cv2.contourArea(approx) > 0.35 * area:
            # Already the whole frame: nothing to crop.
            if cv2.contourArea(approx) > 0.97 * area:
                return None
            src = _order_corners(approx.reshape(4, 2).astype(np.float32) / scale)
            w = int(max(np.linalg.norm(src[0] - src[1]), np.linalg.norm(src[2] - src[3])))
            h = int(max(np.linalg.norm(src[0] - src[3]), np.linalg.norm(src[1] - src[2])))
            dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
            return cv2.warpPerspective(img, cv2.getPerspectiveTransform(src, dst), (w, h))
    return None


def resize_long_side(img: np.ndarray, target: int) -> np.ndarray:
    scale = target / max(img.shape[:2])
    if 0.9 < scale < 1.1:
        return img
    interp = cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA
    return cv2.resize(img, None, fx=scale, fy=scale, interpolation=interp)


def estimate_skew(gray: np.ndarray, max_deg: float) -> float:
    """Angle that makes text rows sharpest (max variance of the horizontal ink profile).

    Projection profiles are robust to sensor noise and need no straight lines on
    the page, unlike Hough-based estimates.
    """
    small = resize_long_side(gray, 900)
    small = cv2.medianBlur(small, 3)
    _, ink = cv2.threshold(small, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ink = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))  # drop speckle

    def sharpness(angle: float) -> float:
        h, w = ink.shape
        m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        rotated = cv2.warpAffine(ink, m, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
        return float(np.var(rotated.sum(axis=1, dtype=np.float64)))

    coarse = np.arange(-max_deg, max_deg + 1e-9, 0.5)
    best = max(coarse, key=sharpness)
    fine = np.arange(best - 0.5, best + 0.5 + 1e-9, 0.1)
    return round(float(max(fine, key=sharpness)), 2)


def rotate(img: np.ndarray, degrees: float) -> np.ndarray:
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), degrees, 1.0)
    cos, sin = abs(m[0, 0]), abs(m[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    m[0, 2] += nw / 2 - w / 2
    m[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, m, (nw, nh), flags=cv2.INTER_CUBIC, borderValue=255)


def prepare(source, cfg: dict) -> Prepared:
    pc = cfg["ocr"]["preprocess"]
    img = load_image(source)
    steps = []
    if pc["perspective_crop"]:
        cropped = perspective_crop(img)
        if cropped is not None:
            img, steps = cropped, steps + ["perspective_crop"]
    img = resize_long_side(img, pc["target_long_side"])
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    if pc["denoise"]:
        gray, steps = cv2.fastNlMeansDenoising(gray, None, h=10, templateWindowSize=7, searchWindowSize=21), steps + ["denoise"]
    skew = 0.0
    if pc["deskew"]:
        skew = estimate_skew(gray, pc["max_skew_degrees"])
        if abs(skew) > 0.3:
            gray, steps = rotate(gray, skew), steps + [f"deskew {skew:.1f}deg"]
    if pc["clahe"]:
        gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
        steps.append("clahe")
    # Flatten uneven lighting (shadows from a phone held over the bill) before binarising.
    background = cv2.medianBlur(gray, 41)
    flat = cv2.divide(gray, background, scale=255)
    binary = cv2.adaptiveThreshold(flat, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 12)
    return Prepared(gray=gray, binary=binary, steps=steps, skew_degrees=skew)
