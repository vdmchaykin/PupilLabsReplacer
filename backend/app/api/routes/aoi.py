import base64
import csv
import json
import re
import threading
from pathlib import Path
from typing import Any, List, Optional

import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
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


def _gaze_dir(folder_path: str) -> Path:
    d = Path(folder_path) / "gaze_analysis"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _upload_source_path(adir: Path, segment_id: str) -> Path:
    """Per-segment raw reference image. Each segment keeps its own upload source so
    re-warping one segment never reads another segment's image."""
    if not _SEGMENT_ID_RE.match(segment_id):
        raise HTTPException(status_code=400, detail="Invalid segment id")
    return adir / f"upload_source_{segment_id}.jpg"


def _invalidate_surface(adir: Path) -> None:
    """Delete a stale surface_positions.csv (and its cached definition).

    The surface definition changes whenever the user re-detects/re-saves tags, so
    any previously generated positions no longer match and must be regenerated."""
    for name in ("surface_positions.csv", "surface.json"):
        p = adir / name
        if p.exists():
            p.unlink()


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


class DetectImageRequest(BaseModel):
    image_b64: str
    segment_id: str = "general"


class TagInfo(BaseModel):
    tag_id: int
    center: List[float]
    corners: List[List[float]]


class AoiStateBody(BaseModel):
    areas: List[Any] = []
    reference_timestamp_s: Optional[float] = None
    warped_image_b64: Optional[str] = None          # active background (video or reference)
    video_warped_image_b64: Optional[str] = None    # baseline warp from the video frame
    reference_image_b64: Optional[str] = None        # warp from an uploaded reference image
    using_reference: bool = False                    # whether the reference image is active
    tag_count: Optional[int] = None
    selected_tags: Optional[List[TagInfo]] = None    # tags defining the surface (for surface_positions.csv)


class CustomSegment(BaseModel):
    id: str
    label: str


class SegmentsManifest(BaseModel):
    custom_segments: List[CustomSegment] = []


def _detect_and_warp(frame: np.ndarray, timestamp_s: float) -> dict:
    """Run AprilTag detection on a BGR frame and auto-warp using all detected tags.

    Shared by the video-frame and uploaded-image entry points so both return the
    exact same payload shape. The auto-warp here is only a first preview — the
    frontend recomputes it via /warp-from-selection whenever tags are toggled.
    """
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    detections = _make_apriltag_detector().detect(gray)

    annotated = frame.copy()
    tag_infos = []
    warp_tags = []
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
        warp_tags.append(TagInfo(
            tag_id=int(det.tag_id),
            center=[float(det.center[0]), float(det.center[1])],
            corners=det.corners.tolist(),
        ))

    warped_b64 = _warp_frame(frame, warp_tags) if len(warp_tags) >= 3 else None

    _, ann_buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 82])
    frame_b64 = base64.b64encode(ann_buf).decode()

    return {
        "tag_count": len(detections),
        "tags": tag_infos,
        "frame_b64": frame_b64,
        "warped_image_b64": warped_b64,
        "timestamp_s": timestamp_s,
        "success": warped_b64 is not None,
        "frame_width": frame.shape[1],
        "frame_height": frame.shape[0],
    }


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

    return _detect_and_warp(frame, req.timestamp_s)


@router.post("/detect-image")
async def detect_image(recording_id: str, req: DetectImageRequest):
    """Detect AprilTags on a user-uploaded reference image (base64-encoded).

    The raw image is cached at aoi/upload_source.jpg so /warp-from-selection can
    re-warp it when the user toggles tags, without re-uploading the file."""
    if not _APRILTAG_AVAILABLE:
        raise HTTPException(status_code=500, detail="pupil-apriltags not installed")

    rec = await _get_recording(recording_id)

    raw = req.image_b64.split(",", 1)[-1]  # tolerate a data-URI prefix
    try:
        img_bytes = base64.b64decode(raw)
        buf = np.frombuffer(img_bytes, dtype=np.uint8)
        frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    except Exception:
        frame = None
    if frame is None:
        raise HTTPException(status_code=400, detail="Could not decode uploaded image")

    adir = _aoi_dir(rec["folder_path"])
    cv2.imwrite(str(_upload_source_path(adir, req.segment_id)), frame)

    # timestamp_s = -1 signals an uploaded source rather than a video position
    return _detect_and_warp(frame, -1.0)


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
    _invalidate_surface(adir)
    _invalidate_aoi_metrics(adir)
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
    _invalidate_surface(adir)
    _invalidate_aoi_metrics(adir)
    return {"ok": True}


# ─── Warp from manually selected tags ────────────────────────────────────────

class WarpSelectionRequest(BaseModel):
    timestamp_s: float
    selected_tags: List[TagInfo]
    source: str = "video"  # "video" reads the scene frame; "upload" reads the segment's upload source
    segment_id: str = "general"


def _surface_corners_from_tags(
    tags: List[TagInfo], frame_w: int, frame_h: int
) -> Optional[np.ndarray]:
    """Estimate the 4 outer paper corners [TL, TR, BR, BL] (in scene px) from tags.

    Uses each tag's outer corner (farthest from the paper centre) rather than its
    centre for accuracy. With 3 tags the missing 4th corner is estimated via a
    parallelogram. Returns a (4, 2) float32 array or None if fewer than 3 tags.
    """
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
        d_tr = np.linalg.norm(other - np.array([frame_w, 0]))
        d_bl = np.linalg.norm(other - np.array([0, frame_h]))
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

    return np.array(src_pts, dtype=np.float32)


def _warp_frame(frame: np.ndarray, tags: List[TagInfo]) -> Optional[str]:
    """Compute perspective warp from a list of tag infos; returns base64 JPEG or None."""
    src_pts = _surface_corners_from_tags(tags, frame.shape[1], frame.shape[0])
    if src_pts is None:
        return None

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

    if req.source == "upload":
        adir = _aoi_dir(rec["folder_path"])
        src_file = _upload_source_path(adir, req.segment_id)
        if not src_file.exists():
            # Fall back to the legacy shared filename for older uploads
            legacy = adir / "upload_source.jpg"
            src_file = legacy if legacy.exists() else src_file
        if not src_file.exists():
            raise HTTPException(status_code=404, detail="Uploaded source image not found")
        frame = cv2.imread(str(src_file))
        if frame is None:
            raise HTTPException(status_code=400, detail="Could not read uploaded source image")
    else:
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


# ─── Surface positions (Pupil-compatible surface_positions.csv) ───────────────
# For every scene-camera frame, localise the AoI surface and record its 4 corners
# in scene pixels. The surface is defined once (from the user-selected reference
# tags) as a per-marker registry of normalised surface coordinates; each frame is
# then localised independently from whichever registered markers are visible.

_surface_jobs: dict = {}

_SURFACE_COLS = [
    "section id", "timestamp [ns]", "detected markers",
    "tl x [px]", "tl y [px]", "tr x [px]", "tr y [px]",
    "br x [px]", "br y [px]", "bl x [px]", "bl y [px]",
]


def _load_scene_timestamps(scene_path: str) -> np.ndarray:
    """Per-frame device timestamps (ns) from the scene camera's sibling .time file.

    One uint64 entry per video frame — the authoritative timestamp source, exactly
    as used for the eye stream in gaze.py."""
    time_file = Path(scene_path).with_suffix(".time")
    if time_file.exists():
        return np.fromfile(str(time_file), dtype=np.uint64).astype(np.int64)
    return np.array([], dtype=np.int64)


def _build_surface_registry(
    selected_tags: List[TagInfo], frame_w: int, frame_h: int
) -> Optional[dict]:
    """Map each selected tag's 4 corners into normalised surface coords [0,1]².

    Returns {tag_id: [[u,v]×4]} keyed by int tag id, or None if the surface plane
    could not be established from the given tags."""
    corners = _surface_corners_from_tags(selected_tags, frame_w, frame_h)
    if corners is None:
        return None
    dst_pts = np.array([[0, 0], [OUTPUT_W, 0], [OUTPUT_W, OUTPUT_H], [0, OUTPUT_H]], dtype=np.float32)
    H, _ = cv2.findHomography(corners, dst_pts, method=0)  # scene px -> A4 px
    if H is None:
        return None
    registry: dict = {}
    for t in selected_tags:
        pts = np.array(t.corners, dtype=np.float32).reshape(-1, 1, 2)
        mapped = cv2.perspectiveTransform(pts, H).reshape(-1, 2)  # A4 px
        norm = mapped / np.array([OUTPUT_W, OUTPUT_H], dtype=np.float32)
        registry[int(t.tag_id)] = norm.tolist()
    return registry


def _surface_scene_homography(detections, registry: dict) -> Optional[np.ndarray]:
    """Robust homography normalized-paper [0,1]² → scene pixels for one frame.

    Correspondences are (registered normalized corner → detected scene corner) for
    every visible registered marker. RANSAC (threshold in SCENE PIXELS) rejects
    wrong-plane detections — crucially, a DUPLICATE tag id from another physical
    paper reprojects to a scene location far from where it actually is, so its
    corners fall out as outliers. Needs ≥1 registered marker (4 correspondences)."""
    src, dst = [], []
    for det in detections:
        reg = registry.get(int(det.tag_id))
        if reg is None:
            continue
        reg = np.array(reg, dtype=np.float32)
        cor = np.asarray(det.corners, dtype=np.float32)
        for k in range(4):
            src.append(reg[k])
            dst.append(cor[k])
    if len(src) < 4:
        return None
    src = np.array(src, dtype=np.float32)
    dst = np.array(dst, dtype=np.float32)
    method = cv2.RANSAC if len(src) > 4 else 0
    H, _ = cv2.findHomography(src, dst, method=method, ransacReprojThreshold=3.0)
    return H  # surface (norm) -> scene px


def _localize_surface(detections, registry: dict) -> Optional[np.ndarray]:
    """Surface corners [TL, TR, BR, BL] in scene pixels (or None if not localized)."""
    H = _surface_scene_homography(detections, registry)
    if H is None:
        return None
    unit = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.float32).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(unit, H).reshape(-1, 2)


def _run_surface_positions(
    recording_id: str, scene_video: str, folder_path: str,
    section_id: str, registry: dict,
) -> None:
    job = _surface_jobs[recording_id]
    try:
        adir = _aoi_dir(folder_path)
        out_csv = adir / "surface_positions.csv"
        timestamps = _load_scene_timestamps(scene_video)

        cap = cv2.VideoCapture(scene_video)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or len(timestamps)
        frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        job["total"] = total

        detector = _make_apriltag_detector(_BULK_QUAD_DECIMATE, _BULK_NTHREADS)

        localized = 0
        with open(out_csv, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(_SURFACE_COLS)
            idx = 0
            while True:
                if job.get("cancelled"):
                    break
                ok, frame = cap.read()
                if not ok:
                    break
                ts = int(timestamps[idx]) if idx < len(timestamps) else ""
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                dets = detector.detect(gray)
                matched = sorted({int(d.tag_id) for d in dets if int(d.tag_id) in registry})
                corners = _localize_surface(dets, registry)
                if corners is not None:
                    vals = [f"{v:.3f}" for p in corners for v in p]
                    localized += 1
                else:
                    vals = [""] * 8
                writer.writerow([section_id, ts, ";".join(map(str, matched)), *vals])
                idx += 1
                job["progress"] = idx
        cap.release()

        _ = (frame_w, frame_h)  # available for future validation/debug
        if job.get("cancelled"):
            out_csv.unlink(missing_ok=True)
            job["status"] = "idle"
        else:
            job["localized"] = localized
            job["status"] = "done"
    except Exception as e:  # pragma: no cover - surfaced via status endpoint
        job["status"] = "error"
        job["message"] = str(e)


def _load_segment_state(adir: Path, segment_id: str) -> dict:
    """Read a segment's saved AoI state, falling back to legacy state.json."""
    path = adir / f"{segment_id}.json"
    if path.exists():
        return json.loads(path.read_text())
    if segment_id == "general":
        legacy = adir / "state.json"
        if legacy.exists():
            return json.loads(legacy.read_text())
    return {}


def _make_apriltag_detector(quad_decimate: float = 1.0, nthreads: int = 2):
    """The tag36h11 detector configuration used throughout this module.

    Per-frame detection MUST use the same corner winding as the reference
    detection so the surface registry matches corners by index — ``quad_decimate``
    only trades corner precision for speed (the quad is found on a downscaled image
    then refined via ``refine_edges``), it does NOT change corner order. Reference/
    interactive detection keeps ``quad_decimate=1.0`` for precision; the bulk
    per-frame video passes bump it (≈3× faster on 1600×1200) since RANSAC over many
    corners absorbs the small precision loss."""
    return apriltag.Detector(
        families="tag36h11", nthreads=nthreads, quad_decimate=quad_decimate,
        quad_sigma=0.0, refine_edges=1, decode_sharpening=0.25,
    )


# quad_decimate/nthreads for the full-video per-frame passes (gaze mapping,
# surface_positions) — the reference detection stays at the precise default.
_BULK_QUAD_DECIMATE = 2.0
_BULK_NTHREADS = 4


def _scene_to_paper_H(detections, registry: dict) -> Optional[np.ndarray]:
    """Homography mapping scene pixels → normalized paper [0,1]² from the surface.

    Built by inverting the robust normalized→scene homography (see
    :func:`_surface_scene_homography`) so the same scene-pixel RANSAC rejects
    wrong-plane / duplicate-id tags. This is the SAME surface plane the AoI editor
    warps onto, so mapped gaze lands in the AoI coordinate system."""
    H_ns = _surface_scene_homography(detections, registry)
    if H_ns is None:
        return None
    try:
        return np.linalg.inv(H_ns)  # scene px -> paper norm
    except np.linalg.LinAlgError:
        return None


def _build_registry_from_state(adir: Path, segment_id: str, scene_video: str) -> Optional[dict]:
    """Build a surface marker registry for one segment.

    Uses the segment's saved ``selected_tags``; for legacy states without them,
    re-detects AprilTags on the stored reference frame. Returns ``{tag_id: [[u,v]×4]}``
    (normalized paper coords) or None if no surface can be established."""
    state = _load_segment_state(adir, segment_id)
    raw_tags = state.get("selected_tags")

    cap = cv2.VideoCapture(scene_video)
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    try:
        if raw_tags and len(raw_tags) >= 3:
            selected_tags = [TagInfo(**t) for t in raw_tags]
        else:
            ref_ts = state.get("reference_timestamp_s")
            if ref_ts is None or ref_ts < 0:
                return None
            cap.set(cv2.CAP_PROP_POS_MSEC, ref_ts * 1000)
            ok, frame = cap.read()
            if not ok:
                return None
            dets = _make_apriltag_detector().detect(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
            selected_tags = [
                TagInfo(tag_id=int(d.tag_id), center=[float(d.center[0]), float(d.center[1])],
                        corners=d.corners.tolist())
                for d in dets
            ]
            if len(selected_tags) < 3:
                return None
    finally:
        cap.release()

    return _build_surface_registry(selected_tags, frame_w, frame_h)


def _build_recording_registry(adir: Path, scene_video: str) -> Optional[dict]:
    """Registry for the recording's physical surface (shared across segments).

    Every segment is drawn on the same paper, so any segment's tags define the same
    normalized plane. Prefers ``general`` (covers legacy state.json), then scans the
    other segment states."""
    if not _APRILTAG_AVAILABLE:
        return None
    tried = {"general"}
    reg = _build_registry_from_state(adir, "general", scene_video)
    if reg:
        return reg
    for p in sorted(adir.glob("*.json")):
        sid = p.stem
        if sid in tried or sid in ("surface", "state") or not _SEGMENT_ID_RE.match(sid):
            continue
        tried.add(sid)
        reg = _build_registry_from_state(adir, sid, scene_video)
        if reg:
            return reg
    return None


@router.post("/surface-positions")
async def start_surface_positions(recording_id: str, segment_id: str = "general"):
    if not _APRILTAG_AVAILABLE:
        raise HTTPException(status_code=500, detail="pupil-apriltags not installed")
    if not _SEGMENT_ID_RE.match(segment_id):
        raise HTTPException(status_code=400, detail="Invalid segment id")

    rec = await _get_recording(recording_id)
    scene_video = rec.get("scene_video")
    if not scene_video or not Path(scene_video).exists():
        raise HTTPException(status_code=404, detail="Scene video not found")

    adir = _aoi_dir(rec["folder_path"])
    registry = _build_registry_from_state(adir, segment_id, scene_video)
    if registry is None:
        raise HTTPException(
            status_code=400,
            detail="No surface defined. Detect 3+ AprilTags on a frame and Save first.",
        )

    (adir / "surface.json").write_text(json.dumps({
        "OUTPUT_W": OUTPUT_W, "OUTPUT_H": OUTPUT_H,
        "segment_id": segment_id, "markers": registry,
    }))

    _surface_jobs[recording_id] = {
        "status": "running", "progress": 0, "total": 0,
        "cancelled": False, "message": "Starting…", "localized": 0,
    }
    t = threading.Thread(
        target=_run_surface_positions,
        args=(recording_id, scene_video, rec["folder_path"], recording_id, registry),
        daemon=True,
    )
    t.start()
    return {"started": True, "markers": len(registry)}


@router.get("/surface-positions")
async def surface_positions_status(recording_id: str):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    has_file = (adir / "surface_positions.csv").exists()
    job = _surface_jobs.get(recording_id)
    if not job:
        return {
            "status": "done" if has_file else "idle",
            "progress": 0, "total": 0, "has_file": has_file,
        }
    return {
        "status": job["status"],
        "progress": job.get("progress", 0),
        "total": job.get("total", 0),
        "localized": job.get("localized", 0),
        "message": job.get("message", ""),
        "has_file": has_file,
    }


@router.post("/surface-positions/cancel")
async def cancel_surface_positions(recording_id: str):
    job = _surface_jobs.get(recording_id)
    if job and job["status"] == "running":
        job["cancelled"] = True
    return {"ok": True}


@router.get("/surface-positions/file")
async def download_surface_positions(recording_id: str):
    rec = await _get_recording(recording_id)
    path = _aoi_dir(rec["folder_path"]) / "surface_positions.csv"
    if not path.exists():
        raise HTTPException(status_code=404, detail="surface_positions.csv not found")
    return FileResponse(str(path), media_type="text/csv", filename="surface_positions.csv")


# ─── AOI fixation metrics (aoi_fixations.csv / aoi_metrics.csv) ───────────────
# Assigns each detected fixation to the AoI shapes it falls inside. Fixation
# surface positions and AoI shapes are both in normalised [0,1]² paper space, so
# membership is a plain point-in-shape test with no scaling.
#
# One export per recording covering EVERY segment at once: AoI shapes are drawn
# per segment, so each row carries the segment it belongs to rather than the
# files being split per segment. Every fixation in the recording is considered,
# regardless of any segment's event time range.

# The trailing "segment id" keeps the documented Pupil column order intact as a
# prefix, so readers that index by position still work.
_AOI_FIXATION_COLS = [
    "label id", "aoi label", "section id", "recording id",
    "fixation id", "fixation duration [ms]", "segment id",
]

_AOI_METRICS_COLS = [
    "label id", "recording id", "recording name", "aoi label",
    "average fixation duration [ms]", "total fixations",
    "time to first fixation [ms]", "total fixation duration [ms]", "segment id",
]

_AOI_EXPORT_STEMS = ("aoi_fixations", "aoi_metrics")

# aoi/*.json names that are not segment state.
_RESERVED_AOI_JSON = {"surface", "segments", "state"}


def _aoi_export_path(adir: Path, stem: str) -> Path:
    return adir / f"{stem}.csv"


def _invalidate_aoi_metrics(adir: Path) -> None:
    """Drop the exports once any segment's AoI shapes change (they no longer match)."""
    for stem in _AOI_EXPORT_STEMS:
        _aoi_export_path(adir, stem).unlink(missing_ok=True)


def _list_aoi_segments(adir: Path) -> List[str]:
    """Every segment id that has saved AoI state, in stable order.

    A segment only has shapes once its state file exists, so the directory is the
    authoritative list — no need to re-derive segments from events here."""
    ids = [
        p.stem for p in sorted(adir.glob("*.json"))
        if p.stem not in _RESERVED_AOI_JSON and _SEGMENT_ID_RE.match(p.stem)
    ]
    # Legacy layout: state.json held "general" before per-segment files existed.
    if "general" not in ids and (adir / "state.json").exists():
        ids.append("general")
    return ids


def _segment_areas(adir: Path) -> List[tuple]:
    """(segment_id, areas) for every segment that actually has drawn shapes."""
    out = []
    for sid in _list_aoi_segments(adir):
        areas = [a for a in _load_segment_state(adir, sid).get("areas", []) if a.get("shape")]
        if areas:
            out.append((sid, areas))
    return out


def _point_in_shape(x: float, y: float, shape: dict) -> bool:
    """Is the normalised paper point (x, y) inside this AoI shape?"""
    kind = shape.get("kind")
    sx, sy = float(shape.get("x", 0.0)), float(shape.get("y", 0.0))
    w, h = float(shape.get("w", 0.0)), float(shape.get("h", 0.0))
    if kind == "rect":
        return sx <= x <= sx + w and sy <= y <= sy + h
    if kind == "ellipse":
        rx, ry = w / 2.0, h / 2.0
        if rx <= 0 or ry <= 0:
            return False
        return ((x - (sx + rx)) / rx) ** 2 + ((y - (sy + ry)) / ry) ** 2 <= 1.0
    if kind == "polygon":
        pts = shape.get("points") or []
        if len(pts) < 3:
            return False
        contour = np.array(pts, dtype=np.float32).reshape(-1, 1, 2)
        return cv2.pointPolygonTest(contour, (float(x), float(y)), False) >= 0
    return False


def _read_surface_fixations(gdir: Path) -> List[dict]:
    """On-surface fixations from fixations_on_surface.csv, ordered by fixation id.

    Rows without a surface position are gaze that missed the paper — they belong
    to no AoI and are dropped here."""
    out: List[dict] = []
    with open(gdir / "fixations_on_surface.csv", newline="") as f:
        for row in csv.DictReader(f):
            if row.get("fixation detected on surface") != "True":
                continue
            nx, ny = row.get("fixation x [normalized]"), row.get("fixation y [normalized]")
            if not nx or not ny:
                continue
            out.append({
                "section_id": row["section id"],
                "fixation_id": int(row["fixation id"]),
                "start_ts": int(row["start timestamp [ns]"]),
                "duration_ms": float(row["duration [ms]"]),
                "x": float(nx), "y": float(ny),
            })
    out.sort(key=lambda r: r["fixation_id"])
    return out


@router.post("/aoi-metrics")
async def generate_aoi_metrics(recording_id: str):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    gdir = _gaze_dir(rec["folder_path"])

    if not (gdir / "fixations_on_surface.csv").exists():
        raise HTTPException(
            status_code=400,
            detail="No fixations yet. Run fixation detection in the Gaze section first.",
        )

    segments = _segment_areas(adir)
    if not segments:
        raise HTTPException(
            status_code=400,
            detail="No areas of interest defined. Draw them in the AoI section first.",
        )

    fixations = _read_surface_fixations(gdir)

    # Time-to-first-fixation is measured from the start of the recording, which
    # precedes the first gaze sample — use the device start time, not the first
    # fixation, so the metric matches Pupil's definition.
    t0 = rec.get("start_time")

    # Every segment's shapes are tested against every fixation: a fixation inside
    # two overlapping AoIs is reported once per AoI, in each segment they belong to.
    hits: dict = {}
    for sid, areas in segments:
        for a in areas:
            hits[(sid, a["id"])] = [
                fx for fx in fixations if _point_in_shape(fx["x"], fx["y"], a["shape"])
            ]

    with open(_aoi_export_path(adir, "aoi_fixations"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(_AOI_FIXATION_COLS)
        for sid, areas in segments:
            for a in areas:
                for fx in hits[(sid, a["id"])]:
                    w.writerow([
                        a["id"], a.get("name", ""), fx["section_id"], recording_id,
                        fx["fixation_id"], round(fx["duration_ms"]), sid,
                    ])

    with open(_aoi_export_path(adir, "aoi_metrics"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(_AOI_METRICS_COLS)
        for sid, areas in segments:
            for a in areas:
                fxs = hits[(sid, a["id"])]
                durs = [fx["duration_ms"] for fx in fxs]
                # An AoI that was never looked at still gets a row, so an ignored
                # AoI is visible as a zero rather than a missing line.
                ttff = ""
                if fxs and t0:
                    ttff = round((min(fx["start_ts"] for fx in fxs) - int(t0)) / 1e6)
                w.writerow([
                    a["id"], recording_id, rec.get("name", ""), a.get("name", ""),
                    round(float(np.mean(durs))) if durs else 0,
                    len(fxs),
                    ttff,
                    round(sum(durs)),
                    sid,
                ])

    n_areas = sum(len(areas) for _, areas in segments)
    return {
        "n_segments": len(segments),
        "n_areas": n_areas,
        "n_areas_fixated": sum(1 for v in hits.values() if v),
        "n_fixations": len(fixations),
        "n_aoi_fixations": sum(len(v) for v in hits.values()),
    }


@router.get("/aoi-metrics")
async def aoi_metrics_status(recording_id: str):
    rec = await _get_recording(recording_id)
    adir = _aoi_dir(rec["folder_path"])
    gdir = _gaze_dir(rec["folder_path"])
    segments = _segment_areas(adir)
    return {
        "has_fixations": (gdir / "fixations_on_surface.csv").exists(),
        "n_segments": len(segments),
        "n_areas": sum(len(areas) for _, areas in segments),
        "has_file": all(_aoi_export_path(adir, stem).exists() for stem in _AOI_EXPORT_STEMS),
    }


@router.get("/aoi-metrics/file/{name}")
async def download_aoi_metrics(recording_id: str, name: str):
    if name not in _AOI_EXPORT_STEMS:
        raise HTTPException(status_code=404, detail="Unknown file")
    rec = await _get_recording(recording_id)
    path = _aoi_export_path(_aoi_dir(rec["folder_path"]), name)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{name}.csv not found")
    return FileResponse(str(path), media_type="text/csv", filename=f"{name}.csv")
