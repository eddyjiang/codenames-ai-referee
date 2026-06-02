"""
Core CV pipeline: decode → detect board → warp → OCR → color classify → BoardState JSON.

Two modes:
  analyze_board() — full pipeline: OCR + color. Use on first scan.
  track_board()   — color only, words provided. Use every subsequent frame.
                    Skips OCR entirely, ~10× faster, immune to stray tiles on the table
                    because we only sample the 25 warped grid cells.
"""

import base64
import logging
import time
from typing import Any, Optional

import cv2
import numpy as np
import pytesseract

logger = logging.getLogger(__name__)

MAX_DIM = 1280


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------

def decode_image(image_base64: str) -> np.ndarray:
    img_bytes = base64.b64decode(image_base64)
    arr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    h, w = img.shape[:2]
    if max(h, w) > MAX_DIM:
        scale = MAX_DIM / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return img


def order_corners(pts: np.ndarray) -> np.ndarray:
    pts = pts.reshape(4, 2).astype(np.float32)
    rect = np.zeros((4, 2), dtype=np.float32)
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
    return rect


# ---------------------------------------------------------------------------
# Board detection & perspective warp
# ---------------------------------------------------------------------------

def _best_quad(contours, img_area: float, min_frac: float) -> Optional[np.ndarray]:
    """Largest convex 4-gon among the biggest contours.

    Approximates the *convex hull* (the board outline is convex, so this drops
    the concavities the 25-card grid carves into the raw contour) and tries
    several tolerances, so a slightly irregular board outline still resolves to
    four corners instead of being rejected.
    """
    best_quad = None
    best_area = 0.0
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:15]:
        area = cv2.contourArea(contour)
        if area < img_area * min_frac:
            break
        hull = cv2.convexHull(contour)
        peri = cv2.arcLength(hull, True)
        for eps in (0.02, 0.03, 0.04, 0.05, 0.07, 0.10):
            approx = cv2.approxPolyDP(hull, eps * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx) and area > best_area:
                best_area = area
                best_quad = approx
                break
    return best_quad


def find_board_corners(img: np.ndarray) -> Optional[np.ndarray]:
    """Find the Codenames board as the largest quadrilateral in the image.

    Most precise first:
      1. Edge contours → largest convex 4-gon (hull + several approx tolerances).
      2. Fallback: the minimum-area rotated rectangle of the largest contour — a
         fitted board rectangle, far better than gridding the whole frame. Only
         used when it covers a plausible board-sized sub-region (15–92% of the
         image); a frame-spanning blob is rejected so we don't pretend to detect.
    Returns four corner points, or None if nothing board-like is found.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 30, 120)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    img_area = float(img.shape[0] * img.shape[1])

    # 1. Clean convex quad.
    quad = _best_quad(contours, img_area, min_frac=0.10)
    if quad is not None:
        return quad

    # 2. Rotated-rectangle fallback over the largest board-sized contour.
    largest = max(contours, key=cv2.contourArea)
    rect = cv2.minAreaRect(largest)
    (_, (rw, rh), _) = rect
    if img_area * 0.15 <= rw * rh <= img_area * 0.92:
        return cv2.boxPoints(rect).astype(np.float32)

    return None


def warp_board(img: np.ndarray, corners: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    src = order_corners(corners)
    w = int(max(np.linalg.norm(src[1] - src[0]), np.linalg.norm(src[2] - src[3])))
    h = int(max(np.linalg.norm(src[3] - src[0]), np.linalg.norm(src[2] - src[1])))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(img, M, (w, h)), M


# ---------------------------------------------------------------------------
# Color classification
# ---------------------------------------------------------------------------

# Hue is the most lighting-stable channel. Measured card hues (OpenCV 0–179):
# red ≈ 6, blue ≈ 107. The cream word card and the near-gray bystander both read
# hue ≈ 24 but at very low saturation, so their hue is noisy and deliberately
# unused — they're separated by saturation + value instead.
def _is_redish(h: float) -> bool:
    return h <= 12 or h >= 168


def _is_blueish(h: float) -> bool:
    return 95 <= h <= 140


# Measured saturations: red ≈ 180, blue ≈ 146, word ≈ 28, bystander ≈ 13 — a ~6×
# gap between coloured tiles and tan cards, so an absolute saturation floor
# cleanly separates "tile" from "tan" (robust across lighting), while relative
# factors handle the close tan-vs-bystander call.
TILE_SAT_FLOOR = 55.0     # a coloured (red/blue) tile clears this; tan never does
TILE_SAT_FACTOR = 1.6     # …and is well above the per-frame word-card baseline
# Bystander (#bdbbb3) vs word card (#e5e0cc): S ≈ 0.48× and V ≈ 0.83× the word
# card — grayer AND dimmer. Requiring *both* avoids false bystanders from a word
# card that merely glares desaturated (low S, still bright) or sits in shadow.
GRAY_SAT_FACTOR = 0.70    # bystander saturation ≲ this × baseline
GRAY_VAL_FACTOR = 0.90    # …AND value ≲ this × baseline
DARK_VAL_FACTOR = 0.45    # assassin value < this × baseline
DARK_VAL_FLOOR = 75.0     # …with an absolute floor for a dim board


def cell_median_hsv(cell_bgr: np.ndarray) -> tuple[float, float, float]:
    """Median (hue, sat, val) over the centre of a cell crop."""
    if cell_bgr.size == 0:
        return (0.0, 0.0, 0.0)
    h, w = cell_bgr.shape[:2]
    my, mx = h // 4, w // 4
    center = cell_bgr[my: h - my, mx: w - mx]
    if center.size == 0:
        center = cell_bgr
    hsv = cv2.cvtColor(center, cv2.COLOR_BGR2HSV)
    return (
        float(np.median(hsv[:, :, 0])),
        float(np.median(hsv[:, :, 1])),
        float(np.median(hsv[:, :, 2])),
    )


def board_reference(hsvs: list[tuple[float, float, float]]) -> tuple[float, float]:
    """Estimate this frame's unrevealed *word-card* baseline → (ref_sat, ref_val).

    Word cards are the bright, warm, non-red/blue cells and are usually the
    majority. We bias toward the more-saturated end of that pool because the
    grayer bystander tiles sit *below* the tan word cards in saturation — so a
    plain median would be dragged down by them.
    """
    bright = [(h, s, v) for (h, s, v) in hsvs if v > 80]
    warm = [
        (h, s, v) for (h, s, v) in bright
        if not (s > 60 and (_is_redish(h) or _is_blueish(h)))
    ]
    pool = warm or bright or list(hsvs)
    if not pool:
        return 30.0, 205.0
    sats = sorted(s for (_, s, _) in pool)
    vals = sorted(v for (_, _, v) in pool)
    # 65th percentile of each biases toward the brighter, slightly-more-saturated
    # word cards (above the grayer, dimmer bystanders) → a word-card baseline.
    i = min(len(pool) - 1, int(len(pool) * 0.65))
    return sats[i], vals[i]


def classify_relative(
    hsv: tuple[float, float, float], ref_s: float, ref_v: float
) -> tuple[Optional[str], bool, float]:
    """Classify one cell *relative* to the frame's word-card baseline.

    Lighting-invariant — tests combine an absolute saturation floor (the ~6× gap
    between coloured tiles and tan is huge and stable) with ratios against the
    per-frame word-card baseline:
      Red / Blue — their (lighting-stable) hue + saturation clearing the tile floor.
      Assassin   — much darker than the word cards.
      Bystander  — grayer AND dimmer than the word cards (both required).
      Unrevealed — looks like the tan baseline.
    Red/blue are checked before assassin so a dark-but-saturated tile isn't
    mistaken for the assassin.
    """
    h, s, v = hsv
    ref_s = max(ref_s, 1.0)
    ref_v = max(ref_v, 1.0)
    sat_tile = max(TILE_SAT_FLOOR, ref_s * TILE_SAT_FACTOR)
    if s >= sat_tile and _is_redish(h):
        return "red", True, 0.85
    if s >= sat_tile and _is_blueish(h):
        return "blue", True, 0.85
    if v < max(DARK_VAL_FLOOR, ref_v * DARK_VAL_FACTOR):
        return "assassin", True, 0.85
    # Bystander: grayer AND dimmer than the word-card baseline (both required).
    if s < ref_s * GRAY_SAT_FACTOR and v < ref_v * GRAY_VAL_FACTOR:
        return "bystander", True, 0.80
    return None, False, 0.82


# ---------------------------------------------------------------------------
# Shared grid helper — used by both full and track pipelines
# ---------------------------------------------------------------------------

def _prepare_grid(img: np.ndarray) -> tuple[np.ndarray, Optional[np.ndarray], int, int, bool]:
    """Detect board, warp to flat rectangle, return grid parameters.

    Returns: (work_image, M_inv, warp_h, warp_w, using_warp)
    The perspective warp crops the image to exactly the board rectangle,
    so stray tiles sitting on the table outside the grid are excluded.
    """
    corners = find_board_corners(img)
    if corners is not None:
        work, M = warp_board(img, corners)
        M_inv = np.linalg.inv(M)
        using_warp = True
    else:
        work = img
        M_inv = None
        using_warp = False
    return work, M_inv, work.shape[0], work.shape[1], using_warp


def _cell_geometry(
    row: int, col: int,
    cell_h: float, cell_w: float,
    orig_h: int, orig_w: int,
    M_inv: Optional[np.ndarray],
    using_warp: bool,
    margin: float = 0.03,
) -> tuple[dict, dict]:
    """Return (bbox, corners) for a grid cell mapped back to original image coordinates.

    margin shrinks the cell inward so adjacent overlays don't bleed into each other.
    """
    x1 = col * cell_w + cell_w * margin
    y1 = row * cell_h + cell_h * margin
    x2 = (col + 1) * cell_w - cell_w * margin
    y2 = (row + 1) * cell_h - cell_h * margin

    pts = np.array([[[x1, y1]], [[x2, y1]], [[x2, y2]], [[x1, y2]]], dtype=np.float32)
    if using_warp and M_inv is not None:
        orig = cv2.perspectiveTransform(pts, M_inv)
    else:
        orig = pts

    def cx(i): return round(float(np.clip(orig[i, 0, 0] / orig_w, 0, 1)), 4)
    def cy(i): return round(float(np.clip(orig[i, 0, 1] / orig_h, 0, 1)), 4)

    corners = {
        "tl": {"x": cx(0), "y": cy(0)},
        "tr": {"x": cx(1), "y": cy(1)},
        "br": {"x": cx(2), "y": cy(2)},
        "bl": {"x": cx(3), "y": cy(3)},
    }

    oxs, oys = orig[:, 0, 0], orig[:, 0, 1]
    bbox = {
        "x": round(float(np.clip(np.min(oxs) / orig_w, 0, 1)), 4),
        "y": round(float(np.clip(np.min(oys) / orig_h, 0, 1)), 4),
        "w": round(float(np.clip((np.max(oxs) - np.min(oxs)) / orig_w, 0, 1)), 4),
        "h": round(float(np.clip((np.max(oys) - np.min(oys)) / orig_h, 0, 1)), 4),
    }
    return bbox, corners


# ---------------------------------------------------------------------------
# Full pipeline (first scan)
# ---------------------------------------------------------------------------

def analyze_board(image_base64: str) -> dict:
    """Full pipeline: decode → detect → warp → OCR → color → BoardState.
    Use for the initial scan to establish the 25 card words.
    """
    img = decode_image(image_base64)
    orig_h, orig_w = img.shape[:2]
    work, M_inv, warp_h, warp_w, using_warp = _prepare_grid(img)

    cell_h, cell_w = warp_h / 5, warp_w / 5

    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    ocr_data: dict[str, Any] = pytesseract.image_to_data(
        thresh, output_type=pytesseract.Output.DICT, config="--psm 11 --oem 3"
    )

    # Pass 1: measure every cell's colour, then derive this frame's word-card baseline.
    hsvs: list[tuple[float, float, float]] = []
    for row in range(5):
        for col in range(5):
            x1, y1 = col * cell_w, row * cell_h
            x2, y2 = x1 + cell_w, y1 + cell_h
            margin = 0.12
            crop = work[
                int(y1 + cell_h * margin): int(y2 - cell_h * margin),
                int(x1 + cell_w * margin): int(x2 - cell_w * margin),
            ]
            hsvs.append(cell_median_hsv(crop))
    ref_s, ref_v = board_reference(hsvs)

    # Pass 2: classify each cell relative to the baseline, then match OCR words.
    cards = []
    for row in range(5):
        for col in range(5):
            pos = row * 5 + col
            x1, y1 = col * cell_w, row * cell_h
            x2, y2 = x1 + cell_w, y1 + cell_h

            hsv = hsvs[pos]
            team, revealed, color_conf = classify_relative(hsv, ref_s, ref_v)

            best_word: Optional[str] = None
            best_ocr_conf = 0.0
            for i, text in enumerate(ocr_data["text"]):
                text = text.strip()
                conf = int(ocr_data["conf"][i])
                if conf < 0 or not text:
                    continue
                cx = ocr_data["left"][i] + ocr_data["width"][i] / 2
                cy = ocr_data["top"][i] + ocr_data["height"][i] / 2
                norm_conf = conf / 100.0
                if x1 <= cx < x2 and y1 <= cy < y2 and norm_conf > best_ocr_conf:
                    word = text.upper()
                    if len(word) >= 2 and not word.isdigit():
                        best_word = word
                        best_ocr_conf = norm_conf

            bbox, corners = _cell_geometry(row, col, cell_h, cell_w, orig_h, orig_w, M_inv, using_warp)
            card_conf = (color_conf + best_ocr_conf) / 2 if best_word else color_conf * 0.6

            cards.append({
                "position": pos,
                "word": best_word,
                "revealed": revealed,
                "team": team,
                "confidence": round(card_conf, 3),
                "bbox": bbox,
                "corners": corners,
                "debug": {"h": round(hsv[0], 1), "s": round(hsv[1], 1), "v": round(hsv[2], 1)},
            })

    detected = sum(1 for c in cards if c["word"])
    overall_conf = sum(c["confidence"] for c in cards) / 25
    issues: list[str] = []
    if not using_warp:
        issues.append("Board corners not detected — try a cleaner background")
    if detected < 20:
        issues.append(f"Only {detected}/25 words read — improve lighting or reduce glare")

    return {
        "board": cards,
        "score": {"red_remaining": None, "blue_remaining": None, "confidence": 0.0},
        "metadata": {
            "overall_confidence": round(overall_conf, 3),
            "issues": issues,
            "partial_visibility": detected < 25,
            "notes": f"cv:full {'warped' if using_warp else 'fullframe'} detected:{detected}/25 ref_s:{ref_s:.0f} ref_v:{ref_v:.0f}",
        },
        "captured_at": int(time.time() * 1000),
    }


# ---------------------------------------------------------------------------
# Track pipeline (subsequent frames)
# ---------------------------------------------------------------------------

def track_board(image_base64: str, known_words: list[Optional[str]]) -> dict:
    """Fast tracking pipeline: color classification only, no OCR.

    Words are provided from the locked first scan, so:
    - ~10× faster than full pipeline (no EasyOCR call)
    - Immune to stray tiles on the table: the perspective warp crops to exactly
      the board rectangle; only the 25 known grid cells are sampled.
    - Robust to slight camera shifts: color classification doesn't depend on
      reading text, so small movement has negligible impact.

    known_words: list of 25 words (or None) from the locked first scan.
    """
    img = decode_image(image_base64)
    orig_h, orig_w = img.shape[:2]
    work, M_inv, warp_h, warp_w, using_warp = _prepare_grid(img)

    cell_h, cell_w = warp_h / 5, warp_w / 5

    # Pass 1: measure every cell's colour, then derive this frame's word-card baseline.
    hsvs: list[tuple[float, float, float]] = []
    for row in range(5):
        for col in range(5):
            x1, y1 = col * cell_w, row * cell_h
            x2, y2 = x1 + cell_w, y1 + cell_h
            margin = 0.12
            crop = work[
                int(y1 + cell_h * margin): int(y2 - cell_h * margin),
                int(x1 + cell_w * margin): int(x2 - cell_w * margin),
            ]
            hsvs.append(cell_median_hsv(crop))
    ref_s, ref_v = board_reference(hsvs)

    # Pass 2: reveal + team come purely from colour, judged *relative* to this
    # frame's word-card baseline (lighting-invariant). No OCR — weak OCR was
    # marking unrevealed cards revealed (inflated count) and flipping revealed
    # tiles back to unrevealed frame-to-frame (the red/blue flicker).
    cards = []
    for pos in range(25):
        row, col = divmod(pos, 5)
        hsv = hsvs[pos]
        team, revealed, color_conf = classify_relative(hsv, ref_s, ref_v)
        bbox, corners = _cell_geometry(row, col, cell_h, cell_w, orig_h, orig_w, M_inv, using_warp)
        cards.append({
            "position": pos,
            "word": known_words[pos] if pos < len(known_words) else None,
            "revealed": revealed,
            "team": team,
            "confidence": round(color_conf, 3),
            "bbox": bbox,
            "corners": corners,
            "debug": {"h": round(hsv[0], 1), "s": round(hsv[1], 1), "v": round(hsv[2], 1)},
        })

    overall_conf = sum(c["confidence"] for c in cards) / 25
    issues: list[str] = []
    if not using_warp:
        issues.append("Board corners not detected — tracking may be less precise")

    return {
        "board": cards,
        "score": {"red_remaining": None, "blue_remaining": None, "confidence": 0.0},
        "metadata": {
            "overall_confidence": round(overall_conf, 3),
            "issues": issues,
            "partial_visibility": False,
            "notes": f"cv:track {'warped' if using_warp else 'fullframe'} ref_s:{ref_s:.0f} ref_v:{ref_v:.0f}",
        },
        "captured_at": int(time.time() * 1000),
    }
