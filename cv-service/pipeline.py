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

def find_board_corners(img: np.ndarray) -> Optional[np.ndarray]:
    """Find the Codenames board as the largest quadrilateral in the image."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 30, 120)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = img.shape[0] * img.shape[1]

    best_quad = None
    best_area = 0.0
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:15]:
        area = cv2.contourArea(contour)
        if area < img_area * 0.10:
            break
        peri = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.025 * peri, True)
        if len(approx) == 4 and area > best_area:
            best_area = area
            best_quad = approx
    return best_quad


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

def classify_color(cell_bgr: np.ndarray) -> tuple[Optional[str], bool, float]:
    """Return (team | None, revealed, confidence) from the card's dominant color.

    Codenames palette (approximate HSV):
      Unrevealed  — cream/parchment: V > 160, S < 70
      Red team    — deep red/burgundy: H near 0 or 180, S > 70
      Blue team   — medium blue: H 100–135, S > 65
      Bystander   — tan/khaki: H 15–50, S 40–140, V > 90
      Assassin    — black tile: V < 65
    """
    if cell_bgr.size == 0:
        return None, False, 0.30

    h, w = cell_bgr.shape[:2]
    my, mx = h // 4, w // 4
    center = cell_bgr[my: h - my, mx: w - mx]
    if center.size == 0:
        center = cell_bgr

    hsv = cv2.cvtColor(center, cv2.COLOR_BGR2HSV)
    hue = float(np.median(hsv[:, :, 0]))
    sat = float(np.median(hsv[:, :, 1]))
    val = float(np.median(hsv[:, :, 2]))

    if val > 160 and sat < 70:
        return None, False, 0.88
    if val < 65:
        return "assassin", True, 0.90
    if sat > 70 and (hue <= 12 or hue >= 168):
        return "red", True, 0.87
    if 100 <= hue <= 135 and sat > 65:
        return "blue", True, 0.87
    if 15 <= hue <= 50 and 40 <= sat <= 140 and val > 90:
        return "bystander", True, 0.83
    return None, False, 0.45


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


def _cell_bbox_in_original(
    row: int, col: int,
    cell_h: float, cell_w: float,
    orig_h: int, orig_w: int,
    M_inv: Optional[np.ndarray],
    using_warp: bool,
) -> dict:
    x1, y1 = col * cell_w, row * cell_h
    x2, y2 = x1 + cell_w, y1 + cell_h
    corners = np.array([[[x1, y1]], [[x2, y1]], [[x2, y2]], [[x1, y2]]], dtype=np.float32)
    if using_warp and M_inv is not None:
        orig = cv2.perspectiveTransform(corners, M_inv)
    else:
        orig = corners
    oxs, oys = orig[:, 0, 0], orig[:, 0, 1]
    return {
        "x": round(float(np.clip(np.min(oxs) / orig_w, 0, 1)), 4),
        "y": round(float(np.clip(np.min(oys) / orig_h, 0, 1)), 4),
        "w": round(float(np.clip((np.max(oxs) - np.min(oxs)) / orig_w, 0, 1)), 4),
        "h": round(float(np.clip((np.max(oys) - np.min(oys)) / orig_h, 0, 1)), 4),
    }


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

    cards = []
    for row in range(5):
        for col in range(5):
            x1, y1 = col * cell_w, row * cell_h
            x2, y2 = x1 + cell_w, y1 + cell_h

            margin = 0.12
            crop = work[
                int(y1 + cell_h * margin): int(y2 - cell_h * margin),
                int(x1 + cell_w * margin): int(x2 - cell_w * margin),
            ]
            team, revealed, color_conf = classify_color(crop)

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

            bbox = _cell_bbox_in_original(row, col, cell_h, cell_w, orig_h, orig_w, M_inv, using_warp)
            card_conf = (color_conf + best_ocr_conf) / 2 if best_word else color_conf * 0.6

            cards.append({
                "position": row * 5 + col,
                "word": best_word,
                "revealed": revealed,
                "team": team,
                "confidence": round(card_conf, 3),
                "bbox": bbox,
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
            "notes": f"cv:full {'warped' if using_warp else 'fullframe'} detected:{detected}/25",
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

    cards = []
    for row in range(5):
        for col in range(5):
            pos = row * 5 + col
            x1, y1 = col * cell_w, row * cell_h
            x2, y2 = x1 + cell_w, y1 + cell_h

            margin = 0.12
            crop = work[
                int(y1 + cell_h * margin): int(y2 - cell_h * margin),
                int(x1 + cell_w * margin): int(x2 - cell_w * margin),
            ]
            team, revealed, color_conf = classify_color(crop)
            bbox = _cell_bbox_in_original(row, col, cell_h, cell_w, orig_h, orig_w, M_inv, using_warp)

            cards.append({
                "position": pos,
                "word": known_words[pos] if pos < len(known_words) else None,
                "revealed": revealed,
                "team": team,
                "confidence": round(color_conf, 3),
                "bbox": bbox,
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
            "notes": f"cv:track {'warped' if using_warp else 'fullframe'}",
        },
        "captured_at": int(time.time() * 1000),
    }
