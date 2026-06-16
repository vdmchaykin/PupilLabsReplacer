import base64
import json
import re
from pathlib import Path
from typing import Any, List, Optional

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import get_db

try:
    import pupil_apriltags as apriltag
    _APRILTAG_AVAILABLE = True
except ImportError:
    _APRILTAG_AVAILABLE = False

router = APIRouter(prefix="/api/recordings/{recording_id}/aoi", tags=["aoi"])

# A4 at 96 dpi
OUTPUT_W, OUTPUT_H = 794, 1123

_SEGMENT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


async def _get_recording(recording_id: str) -> dict:
    db = await get_db()
    try:
        cur = await db.execute("SELECT * FROM recordings WHERE id = ?", (recording_id,))
        row = await cur.fetchone()
    finally:
        await db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Recording not found")
    return dict(row)


def _aoi_dir(folder_path: str) -> Path:
    d = Path(folder_path) / "aoi"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _sort_tl_tr_br_bl(pts: np.ndarray) -> np.ndarray:
    """Sort 4 points into [TL, TR, BR, BL] order using coordinate sums/diffs."""
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).flatten()
    return np.array([
        pts[np.argmin(s)],   # TL: smallest x+y
        pts[np.argmin(d)],   # TR: smallest x-y (large x, small y)
        pts[np.argmax(s)],   # BR: largest x+y
        pts[np.argmax(d)],   # BL: largest x-y (small x, large y)
    ], dtype=np.float32)


def _outer_corner(corners: np.ndarray, paper_center: np.ndarray) -> np.ndarray:
    """Return the tag corner that is farthest from the paper center."""
    dists = np.linalg.norm(corners - paper_center, axis=1)
    return corners[np.argmax(dists)].astype(np.float32)


class DetectFrameRequest(BaseModel):
    timestamp_s: float


class AoiStateBody(BaseModel):
    areas: List[Any] = []
    reference_timestamp_s: Optional[float] = None
    warped_image_b64: Optional[str] = None
    tag_count: Optional[int] = None


class CustomSegment(BaseModel):
    id: str
    label: str


class SegmentsManifest(BaseModel):
    custom_segments: List[CustomSegment] = []


@router.post("/detect-frame")
async def detect_frame(recording_id: str, req: DetectFrameRequest):
    if not _APRILTAG_AVAILABLE:
        raise HTTPException(status_code=500, detail="pupil-apriltags not installed")

    rec = await _get_recording(recording_id)
    video_path = rec.get("scene_video")
    if not video_path or not Path(video_path).exists():
        raise HTTPException(status_code=404, detail="Scene video not found")

    cap = cv2.VideoCapture(video_path)
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, req.timestamp_s * 1000)
        ok, frame = cap.read()
        if not ok:
            raise HTTPException(status_code=400, detail="Could not read frame at given timestamp")
    finally:
        cap.release()

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    detector = apriltag.Detector(
        families="tag36h11",
        nthreads=2,
        quad_decimate=1.0,
        quad_sigma=0.0,
        refine_edges=1,
        decode_sharpening=0.25,
    )
    detections = detector.detect(gray)

    # Draw detection overlays on a copy
    annotated = frame.copy()
    tag_infos = []
    for i, det in enumerate(detections):
        corners = det.corners.astype(int)
        cv2.polylines(annotated, [corners.reshape(-1, 1, 2)], True, (0, 220, 70), 2)
        cx, cy = int(det.center[0]), int(det.center[1])
        cv2.circle(annotated, (cx, cy), 6, (0, 220, 70), -1)
        cv2.putText(
            annotated, f"ID:{det.tag_id}",
            (cx - 15, cy - 14),
            cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 220, 70), 2,
        )
        tag_infos.append({
            "index": i,
            "tag_id": int(det.tag_id),
            "center": [float(det.center[0]), float(det.center[1])],
            "corners": det.corners.tolist(),
        })

    warped_b64 = None

    if len(detections) >= 4:
        centers = np.array([d.center for d in detections[:4]], dtype=np.float32)
        sorted_centers = _sort_tl_tr_br_bl(centers)
        paper_center = centers.mean(axis=0)

        # For each sorted center, find the matching detection and use its outer corner
        all_centers = np.array([d.center for d in detections], dtype=np.float32)
        src_pts = []
        for c in sorted_centers:
            dists = np.linalg.norm(all_centers - c, axis=1)
            det = detections[int(np.argmin(dists))]
            outer = _outer_corner(det.corners, paper_center)
            src_pts.append(outer)

        src_pts = np.array(src_pts, dtype=np.float32)
        dst_pts = np.array([
            [0, 0],
            [OUTPUT_W, 0],
            [OUTPUT_W, OUTPUT_H],
            [0, OUTPUT_H],
        ], dtype=np.float32)

        H, _ = cv2.findHomography(src_pts, dst_pts, method=0)
        if H is not None:
            warped = cv2.warpPerspective(frame, H, (OUTPUT_W, OUTPUT_H))
            _, buf = cv2.imencode(".jpg", warped, [cv2.IMWRITE_JPEG_QUALITY, 92])
            warped_b64 = base64.b64encode(buf).decode()

    elif len(detections) == 3:
        # Parallelogram completion: estimate 4th corner from 3 detected
        centers = np.array([d.center for d in detections], dtype=np.float32)
        # Sort the 3 centers; figure out which arrangement works geometrically
        s = centers.sum(axis=1)
        tl = centers[np.argmin(s)]
        br_est = centers[np.argmax(s)]
        remaining_idx = [i for i in range(3) if i != np.argmin(s) and i != np.argmax(s)]
        other = centers[remaining_idx[0]]

        # Determine if 'other' is TR or BL
        d_tr = np.linalg.norm(other - np.array([frame.shape[1], 0]))
        d_bl = np.linalg.norm(other - np.array([0, frame.shape[0]]))
        if d_tr < d_bl:
            tr, bl = other, tl + br_est - other
        else:
            bl, tr = other, tl + br_est - other

        four_pts = np.array([tl, tr, br_est, bl], dtype=np.float32)
        paper_center = four_pts.mean(axis=0)

        # Use tag outer corners for source points
        all_centers = np.array([d.center for d in detections], dtype=np.float32)
        src_pts = []
        for c in four_pts:
            dists = np.linalg.norm(all_centers - c, axis=1)
            best_idx = int(np.argmin(dists))
            if dists[best_idx] < 100:
                outer = _outer_corner(detections[best_idx].corners, paper_center)
                src_pts.append(outer)
            else:
                src_pts.append(c)  # use estimated corner as-is

        src_pts = np.array(src_pts, dtype=np.float32)
        dst_pts = np.array([
            [0, 0], [OUTPUT_W, 0], [OUTPUT_W, OUTPUT_H], [0, OUTPUT_H],
        ], dtype=np.float32)

        H, _ = cv2.findHomography(src_pts, dst_pts, method=0)
        if H is not None:
            warped = cv2.warpPerspective(frame, H, (OUTPUT_W, OUTPUT_H))
            _, buf = cv2.imencode(".jpg", warped, [cv2.IMWRITE_JPEG_QUALITY, 92])
            warped_b64 = base64.b64encode(buf).decode()

    _, ann_buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
    frame_b64 = base64.b64encode(ann_buf).decode()

    return {
        "tag_count": len(detections),
        "tags": tag_infos,
        "frame_b64": frame_b64,
        "warped_image_b64": warped_b64,
        "timestamp_s": req.timestamp_s,
        "success": warped_b64 is not None,
        "frame_width": frame.shape[1],
        "frame_height": frame.shape[0],
    }


@router.get("/state")
async def get_state(recording_id: str):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    state_file = adir / "state.json"
    if not state_file.exists():
        return {"areas": [], "reference_timestamp_s": None, "warped_image_b64": None, "tag_count": None}
    return json.loads(state_file.read_text())


@router.post("/state")
async def save_state(recording_id: str, body: AoiStateBody):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    state_file = adir / "state.json"
    state_file.write_text(json.dumps(body.model_dump()))
    return {"ok": True}


@router.get("/segments")
async def get_segments(recording_id: str):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    path = adir / "segments.json"
    if not path.exists():
        return {"custom_segments": []}
    return json.loads(path.read_text())


@router.post("/segments")
async def save_segments(recording_id: str, body: SegmentsManifest):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    (adir / "segments.json").write_text(json.dumps(body.model_dump()))
    return {"ok": True}


# ─── Per-segment state endpoints ─────────────────────────────────────────────

@router.get("/{segment_id}/state")
async def get_segment_state(recording_id: str, segment_id: str):
    if not _SEGMENT_ID_RE.match(segment_id):
        raise HTTPException(status_code=400, detail="Invalid segment id")
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    path = adir / f"{segment_id}.json"
    if not path.exists():
        # Migration: for "general" segment, fall back to legacy state.json
        if segment_id == "general":
            legacy = adir / "state.json"
            if legacy.exists():
                return json.loads(legacy.read_text())
        return {"areas": [], "reference_timestamp_s": None, "warped_image_b64": None, "tag_count": None}
    return json.loads(path.read_text())


@router.post("/{segment_id}/state")
async def save_segment_state(recording_id: str, segment_id: str, body: AoiStateBody):
    if not _SEGMENT_ID_RE.match(segment_id):
        raise HTTPException(status_code=400, detail="Invalid segment id")
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    (adir / f"{segment_id}.json").write_text(json.dumps(body.model_dump()))
    return {"ok": True}


# ─── Warp from manually selected tags ────────────────────────────────────────

class TagInfo(BaseModel):
    tag_id: int
    center: List[float]
    corners: List[List[float]]


class WarpSelectionRequest(BaseModel):
    timestamp_s: float
    selected_tags: List[TagInfo]


def _warp_frame(frame: np.ndarray, tags: List[TagInfo]) -> Optional[str]:
    """Compute perspective warp from a list of tag infos; returns base64 JPEG or None."""
    n = len(tags)
    if n < 3:
        return None

    centers = np.array([[t.center[0], t.center[1]] for t in tags[:4]], dtype=np.float32)

    if n >= 4:
        sorted_centers = _sort_tl_tr_br_bl(centers)
        paper_center = centers.mean(axis=0)
        src_pts = []
        for c in sorted_centers:
            dists = np.linalg.norm(centers - c, axis=1)
            t = tags[int(np.argmin(dists))]
            outer = _outer_corner(np.array(t.corners, dtype=np.float32), paper_center)
            src_pts.append(outer)
    else:
        # 3-tag case: estimate 4th corner via parallelogram
        s = centers.sum(axis=1)
        tl = centers[np.argmin(s)]
        br_est = centers[np.argmax(s)]
        remaining = [i for i in range(3) if i != int(np.argmin(s)) and i != int(np.argmax(s))]
        other = centers[remaining[0]]
        d_tr = np.linalg.norm(other - np.array([frame.shape[1], 0]))
        d_bl = np.linalg.norm(other - np.array([0, frame.shape[0]]))
        tr, bl = (other, tl + br_est - other) if d_tr < d_bl else (tl + br_est - other, other)
        four_pts = np.array([tl, tr, br_est, bl], dtype=np.float32)
        paper_center = four_pts.mean(axis=0)
        src_pts = []
        for c in four_pts:
            dists = np.linalg.norm(centers - c, axis=1)
            best = int(np.argmin(dists))
            if dists[best] < 100:
                outer = _outer_corner(np.array(tags[best].corners, dtype=np.float32), paper_center)
                src_pts.append(outer)
            else:
                src_pts.append(c)

    src_pts = np.array(src_pts, dtype=np.float32)
    dst_pts = np.array([[0, 0], [OUTPUT_W, 0], [OUTPUT_W, OUTPUT_H], [0, OUTPUT_H]], dtype=np.float32)
    H, _ = cv2.findHomography(src_pts, dst_pts, method=0)
    if H is None:
        return None
    warped = cv2.warpPerspective(frame, H, (OUTPUT_W, OUTPUT_H))
    _, buf = cv2.imencode(".jpg", warped, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return base64.b64encode(buf).decode()


@router.post("/warp-from-selection")
async def warp_from_selection(recording_id: str, req: WarpSelectionRequest):
    if len(req.selected_tags) < 3:
        return {"warped_image_b64": None, "success": False}

    rec = await _get_recording(recording_id)
    video_path = rec.get("scene_video")
    if not video_path or not Path(video_path).exists():
        raise HTTPException(status_code=404, detail="Scene video not found")

    cap = cv2.VideoCapture(video_path)
    try:
        cap.set(cv2.CAP_PROP_POS_MSEC, req.timestamp_s * 1000)
        ok, frame = cap.read()
    finally:
        cap.release()

    if not ok:
        raise HTTPException(status_code=400, detail="Could not read frame")

    warped_b64 = _warp_frame(frame, req.selected_tags)
    return {"warped_image_b64": warped_b64, "success": warped_b64 is not None}
