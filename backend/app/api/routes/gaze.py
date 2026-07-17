import json
import sys
import threading
from pathlib import Path
from typing import Optional  # noqa: F401 — used in _build_homographies
import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from app.database import get_db
from app.api.routes.aoi import (
    _aoi_dir,
    _gaze_dir,
    _build_recording_registry,
    _make_apriltag_detector,
    _scene_to_paper_H,
    _APRILTAG_AVAILABLE,
    _BULK_QUAD_DECIMATE,
    _BULK_NTHREADS,
)

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent.parent.parent / "Gaze_estimation"))

router = APIRouter(prefix="/api/recordings/{recording_id}/gaze", tags=["gaze"])

# In-memory job state (one job per recording at a time)
_detect_jobs: dict[str, dict] = {}


# ── helpers ────────────────────────────────────────────────────────────────

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


# ── state ──────────────────────────────────────────────────────────────────

def _gaze_state_dict(gdir: Path) -> dict:
    calib_file = gdir / "calibration_points.json"
    calibration_done = calib_file.exists()
    calibration_points = json.loads(calib_file.read_text()) if calibration_done else []
    return {
        "pupils_done": (gdir / "pupils.csv").exists(),
        "calibration_done": calibration_done,
        "mapping_done": (gdir / "gaze_predictions.csv").exists(),
        "fixations_done": (gdir / "fixations.csv").exists(),
        "calibration_points": calibration_points,
    }


# Files produced by each stage, including everything downstream that becomes
# invalid once the stage's data is removed (deleting pupils invalidates the
# calibration matching and the mapping, etc.).
_FIXATION_FILES = ["fixations.csv", "fixations_on_surface.csv", "fixations_result.json"]
_STAGE_FILES: dict[str, list[str]] = {
    "pupils": ["pupils.csv", "pupils_30fps.csv", "detection_stats.json", "calibration_points.json", "gaze_predictions.csv", "mapping_result.json", *_FIXATION_FILES],
    "calibration": ["calibration_points.json", "gaze_predictions.csv", "mapping_result.json", *_FIXATION_FILES],
    "mapping": ["gaze_predictions.csv", "mapping_result.json", *_FIXATION_FILES],
    "fixations": [*_FIXATION_FILES],
}


@router.get("/state")
async def get_gaze_state(recording_id: str):
    rec = await _get_recording(recording_id)
    return _gaze_state_dict(_gaze_dir(rec["folder_path"]))


@router.delete("/data/{stage}")
async def delete_gaze_data(recording_id: str, stage: str):
    """Delete a stage's output and everything downstream that depends on it."""
    if stage not in _STAGE_FILES:
        raise HTTPException(status_code=400, detail=f"Unknown stage '{stage}'")
    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])
    removed = []
    for name in _STAGE_FILES[stage]:
        f = gdir / name
        if f.exists():
            f.unlink()
            removed.append(name)
    if stage == "pupils":
        _detect_jobs.pop(recording_id, None)
    return {"removed": removed, **_gaze_state_dict(gdir)}


# ── video info + frame extraction ──────────────────────────────────────────

@router.get("/info")
async def get_video_info(recording_id: str):
    rec = await _get_recording(recording_id)
    scene_path = rec.get("scene_video")
    if not scene_path or not Path(scene_path).exists():
        raise HTTPException(status_code=404, detail="Scene video not found")

    cap = cv2.VideoCapture(scene_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    return {
        "scene_duration_sec": frame_count / fps if fps else 0,
        "scene_fps": fps,
        "scene_width": w,
        "scene_height": h,
    }


@router.get("/frame")
async def get_frame(recording_id: str, t: float = 0.0):
    rec = await _get_recording(recording_id)
    scene_path = rec.get("scene_video")
    if not scene_path or not Path(scene_path).exists():
        raise HTTPException(status_code=404, detail="Scene video not found")

    cap = cv2.VideoCapture(scene_path)
    cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise HTTPException(status_code=404, detail="Could not read frame")

    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return Response(content=buf.tobytes(), media_type="image/jpeg")


# ── pupil detection ────────────────────────────────────────────────────────

_GAZE_SITE = str(Path(__file__).parents[5] / "Gaze_estimation" / "gaze_env" / "lib" / "python3.12" / "site-packages")
_HEATMAP_CKPT = str(Path(__file__).parents[5] / "Gaze_estimation" / "checkpoints_openeds" / "openeds_finetuned_lpw_validated.pth")


class DetectRequest(BaseModel):
    # Floodfill (primary) detector knobs.
    heatmap_roi_size: int = 35
    floodfill_lo_diff: int = 25
    floodfill_hi_diff: int = 15
    floodfill_blur_ksize: int = 3
    floodfill_min_area: float = 40.0
    floodfill_min_fill_frac: float = 0.55
    floodfill_max_aspect: float = 1.8
    floodfill_seed_search: int = 10
    floodfill_lash_open_ksize: int = 9
    # Edge-based (fallback) detector knobs — mirror EdgeDetectorConfig defaults.
    edge_canny_low: int = 30
    edge_canny_high: int = 90
    edge_spec_thr: int = 220
    edge_spec_dilate: int = 3
    edge_split_min_len: int = 10
    edge_split_max_jump: float = 6.0
    edge_split_corner_deg: float = 75.0
    edge_max_seg_straightness: float = 0.92
    edge_circle_fit_max_rms: float = 0.8
    edge_circle_fit_min_radius: float = 6.0
    edge_circle_fit_max_radius: float = 15.0
    edge_max_center_dist: float = 0.9
    edge_support_dist_px: float = 2.0
    edge_support_min_frac: float = 0.20
    edge_heatmap_prior_weight: float = 0.3


def _floodfill_cfg_from(req: "DetectRequest"):
    if _GAZE_SITE not in sys.path:
        sys.path.insert(0, _GAZE_SITE)
    from pipeline.pupil_detector import DetectorConfig
    return DetectorConfig(
        heatmap_roi_size=req.heatmap_roi_size,
        floodfill_lo_diff=req.floodfill_lo_diff,
        floodfill_hi_diff=req.floodfill_hi_diff,
        floodfill_blur_ksize=req.floodfill_blur_ksize,
        floodfill_min_area=req.floodfill_min_area,
        floodfill_min_fill_frac=req.floodfill_min_fill_frac,
        floodfill_max_aspect=req.floodfill_max_aspect,
        floodfill_seed_search=req.floodfill_seed_search,
        floodfill_lash_open_ksize=req.floodfill_lash_open_ksize,
    )


def _edge_cfg_from(req: "DetectRequest"):
    if _GAZE_SITE not in sys.path:
        sys.path.insert(0, _GAZE_SITE)
    from pipeline.pupil_detector import EdgeDetectorConfig
    return EdgeDetectorConfig(
        heatmap_roi_size=req.heatmap_roi_size,
        canny_low=req.edge_canny_low,
        canny_high=req.edge_canny_high,
        spec_thr=req.edge_spec_thr,
        spec_dilate=req.edge_spec_dilate,
        split_min_len=req.edge_split_min_len,
        split_max_jump=req.edge_split_max_jump,
        split_corner_deg=req.edge_split_corner_deg,
        max_seg_straightness=req.edge_max_seg_straightness,
        circle_fit_max_rms=req.edge_circle_fit_max_rms,
        circle_fit_min_radius=req.edge_circle_fit_min_radius,
        circle_fit_max_radius=req.edge_circle_fit_max_radius,
        max_center_dist=req.edge_max_center_dist,
        support_dist_px=req.edge_support_dist_px,
        support_min_frac=req.edge_support_min_frac,
        heatmap_prior_weight=req.edge_heatmap_prior_weight,
    )


def _fmt(v: float) -> str:
    import math
    return "" if math.isnan(v) else f"{v:.3f}"


def _load_eye_timestamps(eye_path: str, folder_path: str) -> list:
    """Per-frame device timestamps for the eye video.

    The eye camera stream ships its own sibling ``<name>.time`` file (uint64 ns,
    exactly one entry per video frame) — that is the authoritative source for
    timestamping eye-video frames. ``csv/timestamps.csv`` is derived from the GAZE
    stream, which is a different stream with a different sample count (e.g. 34873
    vs 34891 frames here), so using it mislabels every eye frame and leaves the
    trailing frames without a real timestamp. Falls back to the CSV only if the
    sibling ``.time`` file is missing (legacy imports).
    """
    time_file = Path(eye_path).with_suffix(".time")
    if time_file.exists():
        import numpy as np
        return np.fromfile(str(time_file), dtype=np.uint64).astype("int64").tolist()
    return _load_timestamps(folder_path)


def _load_timestamps(folder_path: str) -> list:
    """Load real device timestamps from csv/timestamps.csv. Returns empty list if not found."""
    import csv as csv_mod
    ts_file = Path(folder_path) / "csv" / "timestamps.csv"
    if not ts_file.exists():
        return []
    timestamps = []
    with open(ts_file) as f:
        reader = csv_mod.DictReader(f)
        col = next((c for c in (reader.fieldnames or []) if "timestamp" in c.lower()), None)
        if col:
            for row in reader:
                try:
                    timestamps.append(int(row[col]))
                except (ValueError, KeyError):
                    pass
    return timestamps


# ── clean + downsample to 30 fps (for gaze mapping) ─────────────────────────
# One row per raw eye-video frame in pupils.csv is stabilised into one 30-fps
# row here: gather the raw frames whose device timestamp falls in a ±1/60 s
# window around each 30-fps tick, reject outliers, and average the survivors.
_TARGET_FPS = 30
_CLEAN_OUTLIER_K = 3.0     # keep detections within median + k·(1.4826·MAD) of the 2D spread
_CLEAN_MIN_VALID = 2       # fewer trustworthy detections than this in a window -> NaN (blink/loss)


def _scene_grid(folder_path: str, pupils_df) -> tuple:
    """30-fps timestamp grid + half-window (ns), aligned to the device timeline."""
    import pandas as pd
    ts_eye_csv = Path(folder_path) / "csv" / "timestamps.csv"
    if ts_eye_csv.exists():
        ts_eye = pd.read_csv(ts_eye_csv)
        col = next((c for c in ts_eye.columns if "timestamp" in c.lower()), None)
        t0, t1 = int(ts_eye[col].iloc[0]), int(ts_eye[col].iloc[-1])
    else:
        t0 = int(pupils_df["timestamp_ns"].iloc[0])
        t1 = int(pupils_df["timestamp_ns"].iloc[-1])
    n = max(1, round((t1 - t0) / 1e9 * _TARGET_FPS))
    scene_ts = np.linspace(t0, t1, n, dtype=np.int64)
    half_win = int(1e9 / _TARGET_FPS / 2)
    return scene_ts, half_win


def _reject_and_average(chunk, xcol, ycol, dcol, ccol, scol) -> tuple:
    """One eye, one 30-fps window: prefer floodfill rows, drop 2D outliers via
    median+MAD, then confidence-weighted-average the survivors.
    Returns (x, y, diameter, confidence) or all-NaN when the window is untrustworthy."""
    nan4 = (float("nan"),) * 4
    sub = chunk[[xcol, ycol, dcol, ccol, scol]]
    sub = sub[sub[xcol].notna() & sub[ycol].notna()]
    if len(sub) == 0:
        return nan4

    # source step: commit to floodfill only when there are enough of them,
    # otherwise fall back to every valid detection (floodfill + edge)
    ff = sub[sub[scol] == "floodfill"]
    grp = ff if len(ff) >= _CLEAN_MIN_VALID else sub

    x = grp[xcol].to_numpy(float)
    y = grp[ycol].to_numpy(float)
    if len(grp) >= 3:
        mx, my = np.median(x), np.median(y)
        d = np.hypot(x - mx, y - my)
        md = np.median(d)
        mad = 1.4826 * np.median(np.abs(d - md))
        if mad > 1e-6:
            grp = grp[d <= md + _CLEAN_OUTLIER_K * mad]

    if len(grp) < _CLEAN_MIN_VALID:
        return nan4

    xv = grp[xcol].to_numpy(float)
    yv = grp[ycol].to_numpy(float)
    dv = grp[dcol].to_numpy(float)
    w = grp[ccol].to_numpy(float)
    w = np.where(np.isfinite(w), w, 0.0)
    if w.sum() > 0:
        wsum = w.sum()
        xm, ym = float((xv * w).sum() / wsum), float((yv * w).sum() / wsum)
        dm = float(np.nansum(dv * w) / wsum)
    else:
        xm, ym, dm = float(np.mean(xv)), float(np.mean(yv)), float(np.nanmean(dv))
    cm = float(np.nanmean(grp[ccol].to_numpy(float)))
    return xm, ym, dm, cm


def _build_clean_30fps(pupils_df, folder_path: str):
    """Turn a raw high-fps pupils dataframe into the cleaned 30-fps mapping table."""
    import pandas as pd
    for c in ("xL", "yL", "diameter_L", "confidence_L", "xR", "yR", "diameter_R", "confidence_R"):
        pupils_df[c] = pd.to_numeric(pupils_df[c], errors="coerce")
    scene_ts, half_win = _scene_grid(folder_path, pupils_df)
    ts = pupils_df["timestamp_ns"].to_numpy(np.int64)

    rows = []
    for t in scene_ts:
        chunk = pupils_df[np.abs(ts - t) <= half_win]
        xL, yL, dL, cL = _reject_and_average(chunk, "xL", "yL", "diameter_L", "confidence_L", "source_L")
        xR, yR, dR, cR = _reject_and_average(chunk, "xR", "yR", "diameter_R", "confidence_R", "source_R")
        rows.append({
            "timestamp_ns": int(t),
            "xL": xL, "yL": yL, "diameter_L": dL, "confidence_L": cL,
            "xR": xR, "yR": yR, "diameter_R": dR, "confidence_R": cR,
        })
    return pd.DataFrame(rows, columns=[
        "timestamp_ns", "xL", "yL", "diameter_L", "confidence_L",
        "xR", "yR", "diameter_R", "confidence_R",
    ])


# ── calibration-point feature aggregation ───────────────────────────────────
_CALIB_DWELL_MS = 500          # half-window (ms) around a calibration point to aggregate
_CALIB_MIN_DWELL = 3           # fewer valid frames in the window than this -> use nearest frame
_CALIB_CONF_KEEP_FRAC = 0.5    # keep the top-confidence fraction of the fixation window
_CALIB_MAX_DEGREE = 2          # polynomial degree ceiling for the pupil->gaze map


def _aggregate_dwell(valid_df, ts_center: int, feat_cols: list, half_win_ns: int,
                     conf_col: str = None, keep_frac: float = _CALIB_CONF_KEEP_FRAC,
                     min_frames: int = _CALIB_MIN_DWELL) -> list:
    """Robust feature vector for one calibration point.

    The user fixates the target for a while, so instead of the single nearest
    frame (noise-sensitive) we aggregate the fixation window:
      1. keep the highest-confidence fraction of the window — low-confidence
         detections corrupt the feature even when the detector "succeeded", and
         this is what rescues the noisier calibrations;
      2. take the median of the survivors (robust to the remaining minority of
         off-target frames, e.g. a saccade at the window edge).
    Falls back to the single nearest frame when the window is too sparse.
    """
    ts = valid_df["timestamp_ns"].to_numpy(np.int64)
    sel = valid_df[np.abs(ts - ts_center) <= half_win_ns]
    if len(sel) < min_frames:
        idx = (valid_df["timestamp_ns"] - ts_center).abs().idxmin()
        return [float(valid_df.loc[idx, c]) for c in feat_cols]
    if conf_col is not None and sel[conf_col].notna().any():
        k = max(min_frames, int(len(sel) * keep_frac))
        sel = sel.nlargest(k, conf_col)
    return list(np.median(sel[feat_cols].to_numpy(np.float64), axis=0))


def _run_pupil_detection(recording_id: str, eye_path: str, folder_path: str, out_csv: Path, cfg: DetectRequest):
    import math
    import csv as csv_mod

    job = _detect_jobs[recording_id]
    job["status"] = "running"

    try:
        import sys as _sys
        if _GAZE_SITE not in _sys.path:
            _sys.path.insert(0, _GAZE_SITE)

        from pipeline.pupil_detector import (
            build_combined_detector, DetectorConfig, EdgeDetectorConfig,
            FrameContext, EdgeFrameContext, CombinedFrameContext,
        )

        if not Path(_HEATMAP_CKPT).exists():
            raise FileNotFoundError(f"HeatmapNet checkpoint not found: {_HEATMAP_CKPT}")

        job["message"] = "Loading HeatmapNet model…"
        floodfill_cfg = _floodfill_cfg_from(cfg)
        edge_cfg = _edge_cfg_from(cfg)
        detector, _device = build_combined_detector(floodfill_cfg, edge_cfg, _HEATMAP_CKPT)

        cap = cv2.VideoCapture(eye_path)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS) or 200
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        # Eye video is side-by-side: left eye | right eye
        mid = w // 2
        roi_l = (0, 0, mid, h)
        roi_r = (0, 0, mid, h)

        job["total"] = total
        job["message"] = f"Processing {total} frames…"

        # Per-frame timestamps from the eye camera's own .time file (one per frame)
        device_timestamps = _load_eye_timestamps(eye_path, folder_path)

        # One floodfill + one edge context per eye, reused across frames
        ff_ctx_l = FrameContext(frame_idx=0, roi_rect=roi_l)
        ff_ctx_r = FrameContext(frame_idx=0, roi_rect=roi_r)
        ed_ctx_l = EdgeFrameContext(frame_idx=0, roi_rect=roi_l)
        ed_ctx_r = EdgeFrameContext(frame_idx=0, roi_rect=roi_r)

        # "recording id" leads so rows stay traceable when pupils.csv from several
        # recordings are merged into one project export.
        _FIELDNAMES = [
            "recording id",
            "timestamp [ns]",
            "xL", "yL", "diameter_L", "confidence_L", "A_L", "B_L", "angle_L", "source_L",
            "xR", "yR", "diameter_R", "confidence_R", "A_R", "B_R", "angle_R", "source_R",
        ]

        conf_sum = 0.0
        conf_count = 0
        frame_idx = 0

        with open(out_csv, "w", newline="") as f:
            writer = csv_mod.DictWriter(f, fieldnames=_FIELDNAMES)
            writer.writeheader()

            while True:
                if job.get("cancelled"):
                    break
                ok, frame = cap.read()
                if not ok:
                    break

                left = frame[:, :mid].copy()
                right = frame[:, mid:mid * 2].copy()

                ff_ctx_l.frame_idx = ed_ctx_l.frame_idx = frame_idx
                ff_ctx_r.frame_idx = ed_ctx_r.frame_idx = frame_idx

                if frame_idx < len(device_timestamps):
                    timestamp_ns = device_timestamps[frame_idx]
                elif device_timestamps:
                    # More eye-video frames than device timestamps: extrapolate
                    # past the last known one at the recorded frame cadence so the
                    # timestamp column stays monotonic (mixing absolute device
                    # timestamps with relative frame_idx/fps values corrupts it).
                    n = len(device_timestamps)
                    step = (
                        (device_timestamps[-1] - device_timestamps[0]) / (n - 1)
                        if n >= 2 else 1e9 / fps
                    )
                    timestamp_ns = int(device_timestamps[-1] + (frame_idx - (n - 1)) * step)
                else:
                    timestamp_ns = int((frame_idx / fps) * 1e9)

                try:
                    res_l, _, _ = detector.detect(left, ff_ctx_l, ed_ctx_l)
                except Exception:
                    res_l = CombinedFrameContext(frame_idx=frame_idx, source="none")
                try:
                    res_r, _, _ = detector.detect(right, ff_ctx_r, ed_ctx_r)
                except Exception:
                    res_r = CombinedFrameContext(frame_idx=frame_idx, source="none")

                # Detection failure -> NaN (empty); downstream interpolates. No heatmap fallback.
                writer.writerow({
                    "recording id": recording_id,
                    "timestamp [ns]": timestamp_ns,
                    "xL": _fmt(res_l.pupil_cx), "yL": _fmt(res_l.pupil_cy),
                    "diameter_L": _fmt(res_l.pupil_diameter),
                    "confidence_L": _fmt(res_l.pupil_confidence),
                    "A_L": _fmt(res_l.pupil_A), "B_L": _fmt(res_l.pupil_B),
                    "angle_L": _fmt(res_l.pupil_angle), "source_L": res_l.source or "none",
                    "xR": _fmt(res_r.pupil_cx), "yR": _fmt(res_r.pupil_cy),
                    "diameter_R": _fmt(res_r.pupil_diameter),
                    "confidence_R": _fmt(res_r.pupil_confidence),
                    "A_R": _fmt(res_r.pupil_A), "B_R": _fmt(res_r.pupil_B),
                    "angle_R": _fmt(res_r.pupil_angle), "source_R": res_r.source or "none",
                })

                if not math.isnan(res_l.pupil_confidence):
                    conf_sum += res_l.pupil_confidence
                    conf_count += 1
                if not math.isnan(res_r.pupil_confidence):
                    conf_sum += res_r.pupil_confidence
                    conf_count += 1

                frame_idx += 1
                job["progress"] = frame_idx

        cap.release()

        mean_conf = conf_sum / conf_count if conf_count else 0.0
        job["mean_confidence"] = mean_conf

        if job.get("cancelled"):
            job["status"] = "idle"
            return

        # ── second pass: clean + downsample to 30 fps for gaze mapping ──────
        job["message"] = "Cleaning & downsampling to 30 fps…"
        try:
            import pandas as pd
            raw = pd.read_csv(out_csv).rename(columns={"timestamp [ns]": "timestamp_ns"})
            clean = _build_clean_30fps(raw, folder_path)
            clean.to_csv(out_csv.parent / "pupils_30fps.csv", index=False)
        except Exception as clean_err:
            # non-fatal: mapping rebuilds the 30-fps table from pupils.csv on demand
            job["message"] = f"Clean step skipped ({clean_err}); mapping will rebuild it."

        stats_file = out_csv.parent / "detection_stats.json"
        import json as _json
        stats_file.write_text(_json.dumps({"mean_confidence": mean_conf}))
        job["status"] = "done"

    except Exception as e:
        job["status"] = "error"
        job["message"] = str(e)


@router.post("/detect-pupils")
async def detect_pupils(recording_id: str, req: DetectRequest):
    rec = await _get_recording(recording_id)
    eye_path = rec.get("eye_video")
    if not eye_path or not Path(eye_path).exists():
        raise HTTPException(status_code=400, detail="Eye video not found")

    gdir = _gaze_dir(rec["folder_path"])
    out_csv = gdir / "pupils.csv"

    job: dict = {
        "status": "running", "progress": 0, "total": 0,
        "mean_confidence": 0.0, "cancelled": False,
        "message": "Starting…",
    }
    _detect_jobs[recording_id] = job

    t = threading.Thread(target=_run_pupil_detection, args=(recording_id, eye_path, rec["folder_path"], out_csv, req), daemon=True)
    t.start()
    return {"started": True}


# ── single-frame debug preview ───────────────────────────────────────────────
# Renders the floodfill pipeline stages (ROI → dark-region mask → fitted ellipse)
# for one eye-video frame, so parameters can be inspected without processing the
# whole video. The detector (and its HeatmapNet) is cached and only rebuilt when
# the config changes, keeping previews near-instant.
class DebugRequest(DetectRequest):
    frame: int = 0


_debug_detector: dict = {"key": None, "detector": None}


def _debug_config_key(req: "DebugRequest") -> tuple:
    # Any config field that changes detector behaviour must be here so the cache
    # rebuilds. `frame` is excluded — it does not affect the detector.
    d = req.model_dump()
    d.pop("frame", None)
    return tuple(sorted(d.items()))


def _get_debug_detector(req: "DebugRequest"):
    """Build (or reuse) a combined detector for the given config."""
    if _GAZE_SITE not in sys.path:
        sys.path.insert(0, _GAZE_SITE)
    from pipeline.pupil_detector import build_combined_detector

    key = _debug_config_key(req)
    if _debug_detector["key"] == key and _debug_detector["detector"] is not None:
        return _debug_detector["detector"]

    if not Path(_HEATMAP_CKPT).exists():
        raise HTTPException(status_code=500, detail=f"HeatmapNet checkpoint not found: {_HEATMAP_CKPT}")
    floodfill_cfg = _floodfill_cfg_from(req)
    edge_cfg = _edge_cfg_from(req)
    detector, _device = build_combined_detector(floodfill_cfg, edge_cfg, _HEATMAP_CKPT)
    _debug_detector["key"] = key
    _debug_detector["detector"] = detector
    return detector


def _png_b64(img: np.ndarray) -> str:
    """Encode a BGR/gray image as a base64 PNG data URI."""
    import base64
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        return ""
    return "data:image/png;base64," + base64.b64encode(buf.tobytes()).decode("ascii")


def _debug_stage_images(eye_bgr: np.ndarray, detector, roi_size: int) -> dict:
    """Run the floodfill detector on one eye image and render its stages."""
    if _GAZE_SITE not in sys.path:
        sys.path.insert(0, _GAZE_SITE)
    from pipeline.pupil_detector import FrameContext

    h, w = eye_bgr.shape[:2]
    ctx = FrameContext(frame_idx=0, roi_rect=(0, 0, w, h))
    # Floodfill directly (no edge fallback) — this is the pipeline being tuned.
    state = detector.floodfill_detector.detect(eye_bgr, ctx)

    # Upscale small ROI crops to a readable size with a consistent factor.
    def _scaled(img):
        rh, rw = img.shape[:2]
        if rw == 0 or rh == 0:
            return None
        s = max(1, int(round(180 / max(rw, rh))))
        return cv2.resize(img, (rw * s, rh * s), interpolation=cv2.INTER_NEAREST), s

    roi = state.roi_gray
    roi_png = mask_png = overlay_png = None
    scale = 1
    if roi is not None and roi.size:
        roi_bgr = cv2.cvtColor(roi, cv2.COLOR_GRAY2BGR)
        up = _scaled(roi_bgr)
        if up:
            roi_big, scale = up
            roi_png = _png_b64(roi_big)

    if state.dark_mask is not None and state.dark_mask.size:
        up = _scaled(state.dark_mask)
        if up:
            mask_png = _png_b64(up[0])

    # Overlay: ROI in colour with the fitted ellipse + seed point drawn on top.
    if roi is not None and roi.size:
        x0, y0 = ctx.roi_rect[0], ctx.roi_rect[1]
        overlay = cv2.cvtColor(roi, cv2.COLOR_GRAY2BGR)
        overlay = cv2.resize(overlay, (roi.shape[1] * scale, roi.shape[0] * scale),
                             interpolation=cv2.INTER_NEAREST)
        import math as _m
        if not _m.isnan(ctx.pupil_cx) and not _m.isnan(ctx.pupil_A):
            cx = (ctx.pupil_cx - x0) * scale
            cy = (ctx.pupil_cy - y0) * scale
            axes = (int(ctx.pupil_A / 2 * scale), int(ctx.pupil_B / 2 * scale))
            cv2.ellipse(overlay, (int(cx), int(cy)), axes, ctx.pupil_angle, 0, 360, (0, 255, 0), 2)
        if not _m.isnan(ctx.seed_x):
            sx = int((ctx.seed_x - x0) * scale)
            sy = int((ctx.seed_y - y0) * scale)
            cv2.circle(overlay, (sx, sy), 3, (0, 128, 255), -1)
        overlay_png = _png_b64(overlay)

    return {
        "roi_png": roi_png,
        "mask_png": mask_png,
        "overlay_png": overlay_png,
        "reason": ctx.debug_reason or "",
        "A": _safe_num(ctx.pupil_A),
        "B": _safe_num(ctx.pupil_B),
        "angle": _safe_num(ctx.pupil_angle),
        "confidence": _safe_num(ctx.pupil_confidence),
    }


def _safe_num(v: float):
    import math
    return None if (v is None or math.isnan(v)) else round(float(v), 2)


@router.post("/detect-debug")
async def detect_debug(recording_id: str, req: DebugRequest):
    rec = await _get_recording(recording_id)
    eye_path = rec.get("eye_video")
    if not eye_path or not Path(eye_path).exists():
        raise HTTPException(status_code=400, detail="Eye video not found")

    cap = cv2.VideoCapture(eye_path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    frame_idx = max(0, min(req.frame, max(0, total - 1)))
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        raise HTTPException(status_code=400, detail=f"Could not read frame {frame_idx}")

    w = frame.shape[1]
    mid = w // 2
    left = frame[:, :mid].copy()
    right = frame[:, mid:mid * 2].copy()

    detector = _get_debug_detector(req)
    return {
        "frame": frame_idx,
        "total_frames": total,
        "left": _debug_stage_images(left, detector, req.heatmap_roi_size),
        "right": _debug_stage_images(right, detector, req.heatmap_roi_size),
    }


# ── live full-pipeline video stream (all stages) ─────────────────────────────
# Processes the eye video frame-by-frame and streams an annotated montage of
# every stage (floodfill: ROI→mask→ellipse; edge: S1..S8) for both eyes as MJPEG.
# The processing itself paces the stream — a genuine "watch the algorithm run"
# demo rather than a pre-rendered clip.
_TILE = 130
_LABEL_H = 15


def _mk_tile(img, label: str, cell: int = _TILE) -> np.ndarray:
    canvas = np.full((cell, cell, 3), 30, np.uint8)
    if img is not None and getattr(img, "size", 0):
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        ih, iw = img.shape[:2]
        avail = cell - _LABEL_H
        s = min(avail / iw, avail / ih)
        nw, nh = max(1, int(iw * s)), max(1, int(ih * s))
        rimg = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_NEAREST)
        y0 = _LABEL_H + (avail - nh) // 2
        x0 = (cell - nw) // 2
        canvas[y0:y0 + nh, x0:x0 + nw] = rimg
    cv2.putText(canvas, label, (3, 11), cv2.FONT_HERSHEY_SIMPLEX, 0.32, (200, 200, 200), 1, cv2.LINE_AA)
    return canvas


def _grid(tiles: list, cols: int, cell: int = _TILE) -> np.ndarray:
    rows = []
    for i in range(0, len(tiles), cols):
        row = tiles[i:i + cols]
        while len(row) < cols:
            row.append(np.full((cell, cell, 3), 30, np.uint8))
        rows.append(cv2.hconcat(row))
    return cv2.vconcat(rows)


def _title_strip(text: str, width: int, color=(230, 230, 230), h: int = 22) -> np.ndarray:
    strip = np.full((h, width, 3), 50, np.uint8)
    cv2.putText(strip, text, (6, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
    return strip


def _draw_ellipse_on(roi_gray, ell, color, x_off=0, y_off=0, thickness=1):
    """Return a BGR copy of roi_gray with an ellipse ((cx,cy),(A,B),ang) drawn."""
    import math as _m
    out = cv2.cvtColor(roi_gray, cv2.COLOR_GRAY2BGR)
    if ell is None:
        return out
    (cx, cy), (A, B), ang = ell
    if _m.isnan(cx) or _m.isnan(A):
        return out
    cv2.ellipse(out, (int(cx - x_off), int(cy - y_off)),
                (max(1, int(A / 2)), max(1, int(B / 2))), ang, 0, 360, color, thickness)
    return out


def _eye_stage_tiles(eye_bgr, floodfill_det, edge_det) -> tuple:
    """Run both pipelines on one eye and build the labelled stage tiles."""
    import math as _m
    if _GAZE_SITE not in sys.path:
        sys.path.insert(0, _GAZE_SITE)
    from pipeline.pupil_detector import FrameContext, EdgeFrameContext

    h, w = eye_bgr.shape[:2]
    ff_ctx = FrameContext(frame_idx=0, roi_rect=(0, 0, w, h))
    ff_state = floodfill_det.detect(eye_bgr, ff_ctx)

    ed_ctx = EdgeFrameContext(frame_idx=0, roi_rect=(0, 0, w, h))
    # reuse the heatmap centre from the floodfill pass so the NN runs once
    ed_ctx.heatmap_cx, ed_ctx.heatmap_cy = ff_ctx.heatmap_cx, ff_ctx.heatmap_cy
    ed_state = edge_det.detect(eye_bgr, ed_ctx)

    # ── floodfill tiles ──
    ff_roi = ff_state.roi_gray
    ff_overlay = None
    if ff_roi is not None and ff_roi.size:
        fx0, fy0 = ff_state.roi_rect[0], ff_state.roi_rect[1]
        ff_overlay = cv2.cvtColor(ff_roi, cv2.COLOR_GRAY2BGR)
        if not _m.isnan(ff_ctx.pupil_cx) and not _m.isnan(ff_ctx.pupil_A):
            cv2.ellipse(ff_overlay, (int(ff_ctx.pupil_cx - fx0), int(ff_ctx.pupil_cy - fy0)),
                        (max(1, int(ff_ctx.pupil_A / 2)), max(1, int(ff_ctx.pupil_B / 2))),
                        ff_ctx.pupil_angle, 0, 360, (0, 255, 0), 1)
        if not _m.isnan(ff_ctx.seed_x):
            cv2.circle(ff_overlay, (int(ff_ctx.seed_x - fx0), int(ff_ctx.seed_y - fy0)), 2, (0, 128, 255), -1)
    ff_tiles = [
        _mk_tile(ff_roi, "FF ROI"),
        _mk_tile(ff_state.dark_mask, "FF dark"),
        _mk_tile(ff_overlay, f"FF ellipse [{ff_ctx.debug_reason or '-'}]"),
    ]

    # ── edge tiles S1..S8 ──
    ed_roi = ed_state.roi_gray
    seg_img = cand_img = final_img = None
    if ed_roi is not None and ed_roi.size:
        # S6 segments
        seg_img = cv2.cvtColor(ed_roi, cv2.COLOR_GRAY2BGR)
        palette = [(0, 255, 255), (255, 0, 255), (0, 255, 0), (255, 128, 0), (0, 128, 255)]
        for i, seg in enumerate(ed_state.segments or []):
            pts = np.round(seg).astype(np.int32).reshape(-1, 1, 2)
            cv2.polylines(seg_img, [pts], False, palette[i % len(palette)], 1)
        # S7 candidate ellipses
        cand_img = cv2.cvtColor(ed_roi, cv2.COLOR_GRAY2BGR)
        for cand in (ed_state.candidates or []):
            ell = cand[3]
            (ccx, ccy), (cA, cB), cang = ell
            cv2.ellipse(cand_img, (int(ccx), int(ccy)),
                        (max(1, int(cA / 2)), max(1, int(cB / 2))), cang, 0, 360, (0, 200, 255), 1)
        # S8 final
        final_img = cv2.cvtColor(ed_roi, cv2.COLOR_GRAY2BGR)
        if ed_state.best_ell is not None:
            (bcx, bcy), (bA, bB), bang = ed_state.best_ell
            cv2.ellipse(final_img, (int(bcx), int(bcy)),
                        (max(1, int(bA / 2)), max(1, int(bB / 2))), bang, 0, 360, (0, 255, 0), 1)
    ed_tiles = [
        _mk_tile(ed_roi, "S1 ROI"),
        _mk_tile(ed_state.edges, "S2 Canny"),
        _mk_tile(ed_state.dark_mask, "S3 dark"),
        _mk_tile(ed_state.edges_dark, "S4 edge&dark"),
        _mk_tile(ed_state.edges_filtered, "S5 filtered"),
        _mk_tile(seg_img, "S6 segments"),
        _mk_tile(cand_img, "S7 candidates"),
        _mk_tile(final_img, "S8 final"),
    ]

    # which pipeline would win for this eye
    if ff_ctx.debug_reason == "ok" and not _m.isnan(ff_ctx.pupil_cx):
        src = "floodfill"
    elif not _m.isnan(ed_ctx.pupil_cx):
        src = "edge"
    else:
        src = "none"
    return ff_tiles, ed_tiles, src


def _render_stage_montage(frame, detector, frame_idx: int, total: int) -> np.ndarray:
    w = frame.shape[1]
    mid = w // 2
    eyes = {"LEFT": frame[:, :mid].copy(), "RIGHT": frame[:, mid:mid * 2].copy()}

    blocks = []
    width = 8 * _TILE
    for name, eye in eyes.items():
        ff_tiles, ed_tiles, src = _eye_stage_tiles(eye, detector.floodfill_detector, detector.edge_detector)
        color = (0, 255, 0) if src == "floodfill" else (0, 200, 255) if src == "edge" else (0, 0, 255)
        blocks.append(_title_strip(f"{name} EYE  -  source: {src}", width, color))
        blocks.append(_grid(ed_tiles, 8))   # S1..S8 row
        blocks.append(_grid(ff_tiles, 8))   # floodfill row (3 tiles, padded)

    header = _title_strip(f"Frame {frame_idx} / {max(0, total - 1)}", width, (255, 255, 255))
    return cv2.vconcat([header, *blocks])


@router.get("/detect-stream")
async def detect_stream(
    recording_id: str,
    start: int = 0,
    heatmap_roi_size: int = 35,
    floodfill_lo_diff: int = 25,
    floodfill_hi_diff: int = 15,
    floodfill_blur_ksize: int = 3,
    floodfill_min_area: float = 40.0,
    floodfill_min_fill_frac: float = 0.55,
    floodfill_max_aspect: float = 1.8,
    floodfill_seed_search: int = 10,
    floodfill_lash_open_ksize: int = 9,
    edge_canny_low: int = 30,
    edge_canny_high: int = 90,
    edge_spec_thr: int = 220,
    edge_spec_dilate: int = 3,
    edge_split_min_len: int = 10,
    edge_split_max_jump: float = 6.0,
    edge_split_corner_deg: float = 75.0,
    edge_max_seg_straightness: float = 0.92,
    edge_circle_fit_max_rms: float = 0.8,
    edge_circle_fit_min_radius: float = 6.0,
    edge_circle_fit_max_radius: float = 15.0,
    edge_max_center_dist: float = 0.9,
    edge_support_dist_px: float = 2.0,
    edge_support_min_frac: float = 0.20,
    edge_heatmap_prior_weight: float = 0.3,
):
    rec = await _get_recording(recording_id)
    eye_path = rec.get("eye_video")
    if not eye_path or not Path(eye_path).exists():
        raise HTTPException(status_code=400, detail="Eye video not found")

    req = DebugRequest(
        frame=start, heatmap_roi_size=heatmap_roi_size,
        floodfill_lo_diff=floodfill_lo_diff, floodfill_hi_diff=floodfill_hi_diff,
        floodfill_blur_ksize=floodfill_blur_ksize, floodfill_min_area=floodfill_min_area,
        floodfill_min_fill_frac=floodfill_min_fill_frac, floodfill_max_aspect=floodfill_max_aspect,
        floodfill_seed_search=floodfill_seed_search, floodfill_lash_open_ksize=floodfill_lash_open_ksize,
        edge_canny_low=edge_canny_low, edge_canny_high=edge_canny_high,
        edge_spec_thr=edge_spec_thr, edge_spec_dilate=edge_spec_dilate,
        edge_split_min_len=edge_split_min_len, edge_split_max_jump=edge_split_max_jump,
        edge_split_corner_deg=edge_split_corner_deg, edge_max_seg_straightness=edge_max_seg_straightness,
        edge_circle_fit_max_rms=edge_circle_fit_max_rms, edge_circle_fit_min_radius=edge_circle_fit_min_radius,
        edge_circle_fit_max_radius=edge_circle_fit_max_radius, edge_max_center_dist=edge_max_center_dist,
        edge_support_dist_px=edge_support_dist_px, edge_support_min_frac=edge_support_min_frac,
        edge_heatmap_prior_weight=edge_heatmap_prior_weight,
    )
    detector = _get_debug_detector(req)

    def gen():
        cap = cv2.VideoCapture(eye_path)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        idx = max(0, min(start, max(0, total - 1)))
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                try:
                    montage = _render_stage_montage(frame, detector, idx, total)
                    ok2, jpg = cv2.imencode(".jpg", montage, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    if ok2:
                        yield (b"--frame\r\nContent-Type: image/jpeg\r\n\r\n"
                               + jpg.tobytes() + b"\r\n")
                except Exception:
                    pass
                idx += 1
        finally:
            cap.release()

    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")


@router.post("/detect-cancel")
async def cancel_detection(recording_id: str):
    if recording_id in _detect_jobs:
        _detect_jobs[recording_id]["cancelled"] = True
    return {"cancelled": True}


@router.get("/detect-status")
async def detect_status(recording_id: str):
    if recording_id not in _detect_jobs:
        # Check if already done from a previous session
        try:
            rec = await _get_recording(recording_id)
            gdir = _gaze_dir(rec["folder_path"])
            if (gdir / "pupils.csv").exists():
                stats_file = gdir / "detection_stats.json"
                mean_conf = 0.0
                if stats_file.exists():
                    mean_conf = json.loads(stats_file.read_text()).get("mean_confidence", 0.0)
                return {"status": "done", "progress": 0, "total": 0, "mean_confidence": mean_conf}
        except Exception:
            pass
        return {"status": "idle", "progress": 0, "total": 0, "mean_confidence": 0.0}
    job = _detect_jobs[recording_id]
    return {
        "status": job["status"],
        "progress": job.get("progress", 0),
        "total": job.get("total", 0),
        "mean_confidence": job.get("mean_confidence", 0.0),
        "message": job.get("message"),
    }


# ── calibration ────────────────────────────────────────────────────────────

class CalibrationSaveRequest(BaseModel):
    points: list[dict]


@router.post("/calibration")
async def save_calibration(recording_id: str, req: CalibrationSaveRequest):
    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])
    (gdir / "calibration_points.json").write_text(json.dumps(req.points, indent=2))
    return {"saved": len(req.points)}


@router.get("/calibration")
async def get_calibration(recording_id: str):
    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])
    f = gdir / "calibration_points.json"
    if not f.exists():
        return []
    return json.loads(f.read_text())


# ── gaze mapping ───────────────────────────────────────────────────────────

@router.post("/map")
async def map_gaze(recording_id: str):
    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])
    folder_path = rec["folder_path"]

    pupils_csv = gdir / "pupils.csv"
    calib_json = gdir / "calibration_points.json"

    if not pupils_csv.exists():
        raise HTTPException(status_code=400, detail="Run pupil detection first")
    if not calib_json.exists():
        raise HTTPException(status_code=400, detail="Run calibration first")

    import pandas as pd
    from sklearn.pipeline import Pipeline as SkPipeline
    from sklearn.preprocessing import PolynomialFeatures
    from sklearn.linear_model import Ridge
    from sklearn.model_selection import LeaveOneOut

    # ── 1. Load the cleaned 30-fps pupil table ─────────────────────────────
    # Produced by the detection job (clean + outlier-reject + downsample). For
    # recordings detected before this step existed, rebuild it from pupils.csv
    # with the same algorithm on demand.
    pupils_30 = gdir / "pupils_30fps.csv"
    if pupils_30.exists():
        pupils = pd.read_csv(pupils_30)
    else:
        raw = pd.read_csv(pupils_csv).rename(columns={"timestamp [ns]": "timestamp_ns"})
        pupils = _build_clean_30fps(raw, folder_path)
    for col in ("xL", "yL", "xR", "yR", "diameter_L", "diameter_R"):
        pupils[col] = pd.to_numeric(pupils[col], errors="coerce")

    # The 30-fps grid spans the device timeline [t0, t1]; its first tick is the
    # absolute scene-start timestamp used below to place calibration points.
    t0 = int(pupils["timestamp_ns"].iloc[0])

    # ── 3. Features: cyclopean (averaged) pupil position ───────────────────
    # Only 9 calibration points → the model must stay small. A degree-2
    # polynomial on these 2 inputs = 6 coefficients/axis (9 > 6, over-determined).
    # xL,yL,xR,yR and dx,dy add no independent basis under a degree-2 poly, and
    # IMU/vergence terms can't be learned from 9 points — so they are dropped.
    #
    # Do NOT mirror the left eye. On this hardware both pupils move the same way
    # in raw coords (gaze right → both xL and xR decrease), so a plain average
    # preserves the signal. Mirroring one eye (the old `192 - xL`) makes them
    # anti-correlated and the average cancels the horizontal signal — measured
    # LOO error ~85 px with the mirror vs ~8 px without it.
    pupils["xm"] = (pupils["xL"] + pupils["xR"]) / 2
    pupils["ym"] = (pupils["yL"] + pupils["yR"]) / 2

    base_features = ["xm", "ym"]
    all_features = base_features

    # Per-frame confidence (worse of the two eyes) — used to keep only the
    # highest-confidence frames inside each calibration fixation window.
    conf_col = None
    if {"confidence_L", "confidence_R"}.issubset(pupils.columns):
        for col in ("confidence_L", "confidence_R"):
            pupils[col] = pd.to_numeric(pupils[col], errors="coerce")
        pupils["cmin"] = pupils[["confidence_L", "confidence_R"]].min(axis=1)
        conf_col = "cmin"

    # ── 5. Match calibration points to the fixation window (median-aggregated) ─
    valid_mask = pupils[base_features].notna().all(axis=1)
    pupils_valid = pupils[valid_mask].reset_index(drop=True)

    if len(pupils_valid) == 0:
        raise HTTPException(status_code=400, detail="No valid pupil detections found")

    calib_points = json.loads(calib_json.read_text())
    if not calib_points:
        raise HTTPException(status_code=400, detail="No calibration points")

    # Frontend saves timestamp_ns = seekTime * 1e9 (seconds from scene video start).
    # Scene and eye cameras are hardware-synced on Neon: both cover [t0, t1], so a
    # calibration point at seekTime maps to absolute timestamp t0 + seekTime_ns.
    # Aggregate the pupil over the fixation window (not one frame) to cut noise.
    half_win_ns = int(_CALIB_DWELL_MS * 1e6)
    merged_rows = []
    for cp in calib_points:
        ts = t0 + cp["timestamp_ns"]
        feats = _aggregate_dwell(pupils_valid, ts, all_features, half_win_ns, conf_col=conf_col)
        merged_rows.append({
            "point_id": cp["point_id"],
            **{f: v for f, v in zip(all_features, feats)},
            "gaze_x": cp["gaze_x"],
            "gaze_y": cp["gaze_y"],
        })

    merged = pd.DataFrame(merged_rows).dropna(subset=base_features).reset_index(drop=True)
    if len(merged) == 0:
        raise HTTPException(status_code=400, detail="Calibration points have no matching valid pupil data")

    X_train = merged[all_features].to_numpy(np.float64)
    y_train = merged[["gaze_x", "gaze_y"]].to_numpy(np.float64)
    point_ids = merged["point_id"].tolist()

    # ── 6. Fit polynomial Ridge; choose (degree, alpha) by leave-one-out CV ─
    def _make_model(degree: int, alpha: float):
        return SkPipeline([
            ("poly", PolynomialFeatures(degree=degree, include_bias=False)),
            ("ridge", Ridge(alpha=alpha)),
        ])

    def _loo_predictions(degree: int, alpha: float) -> np.ndarray:
        """Held-out prediction for each point (trained on the other N-1)."""
        preds = np.empty_like(y_train)
        for tr_idx, te_idx in LeaveOneOut().split(X_train):
            m = _make_model(degree, alpha)
            m.fit(X_train[tr_idx], y_train[tr_idx])
            preds[te_idx] = m.predict(X_train[te_idx])
        return preds

    alpha_grid = [0.001, 0.01, 0.1, 1.0, 3.0, 10.0, 30.0, 100.0]
    # deg-2 has 6 params/axis — only offer it with enough points to over-determine it
    degree_grid = [1, 2] if len(merged) >= 6 else [1]
    degree_grid = [d for d in degree_grid if d <= _CALIB_MAX_DEGREE]
    if len(merged) >= 3:
        loo_err = {
            (d, a): float(np.mean(np.linalg.norm(_loo_predictions(d, a) - y_train, axis=1)))
            for d in degree_grid for a in alpha_grid
        }
        best_degree, best_alpha = min(loo_err, key=loo_err.get)
    else:
        best_degree, best_alpha = 1, 10.0  # too few points for CV — safe default

    model = _make_model(best_degree, best_alpha)
    model.fit(X_train, y_train)

    # ── 7. Residuals: leave-one-out (honest) alongside in-sample (optimistic) ─
    y_pred_loo = _loo_predictions(best_degree, best_alpha) if len(merged) >= 3 else model.predict(X_train)
    y_pred_insample = model.predict(X_train)
    residuals = []
    for i in range(len(merged)):
        err = float(np.linalg.norm(y_pred_loo[i] - y_train[i]))
        residuals.append({
            "point_id": point_ids[i],
            "true_x": float(y_train[i][0]),
            "true_y": float(y_train[i][1]),
            "pred_x": float(y_pred_loo[i][0]),
            "pred_y": float(y_pred_loo[i][1]),
            "error_px": err,
        })
    mean_rmse = float(np.mean([r["error_px"] for r in residuals]))
    mean_rmse_insample = float(np.mean(np.linalg.norm(y_pred_insample - y_train, axis=1)))

    # ── 8. Predict for all 30-fps frames (interpolate blinks first) ────────
    pupils_filled = pupils.copy()
    nan_cols = [c for c in all_features if pupils_filled[c].isna().any()]
    if nan_cols:
        pupils_filled[nan_cols] = pupils_filled[nan_cols].interpolate(method="linear").ffill().bfill()

    pred = model.predict(pupils_filled[all_features].to_numpy(np.float64))
    pupils = pupils.reset_index(drop=True)
    pupils["pred_gaze_x"] = pred[:, 0]
    pupils["pred_gaze_y"] = pred[:, 1]

    # ── 9. AprilTag homography (optional) ──────────────────────────────────
    # Uses the AoI editor's surface registry so paper gaze shares its coordinate
    # system (same tag OUTER-corner homography, any tag IDs, 3+ tags).
    scene_path = rec.get("scene_video")
    if scene_path:
        registry = _build_recording_registry(_aoi_dir(folder_path), scene_path)
        scene_ts, homographies = _build_homographies(scene_path, registry)
    else:
        scene_ts, homographies = np.array([], dtype=np.int64), {}
    have_scene_ts = scene_ts.size > 0

    frames_with_gaze = 0
    frames_on_paper = 0
    out_rows = []

    for frame_i, pupil_row in pupils.iterrows():
        px = float(pupil_row["pred_gaze_x"])
        py = float(pupil_row["pred_gaze_y"])
        ts_ns = int(pupil_row["timestamp_ns"])
        frames_with_gaze += 1

        paper_x: Optional[float] = None
        paper_y: Optional[float] = None

        # Match the scene frame by NEAREST TIMESTAMP (not positional index): the
        # pupil 30-fps grid and the scene video are separate streams with a ~4-frame
        # start offset. Fall back to index only if the scene .time file is missing.
        if have_scene_ts:
            j = int(np.searchsorted(scene_ts, ts_ns))
            if j >= scene_ts.size:
                j = scene_ts.size - 1
            elif j > 0 and abs(int(scene_ts[j - 1]) - ts_ns) <= abs(int(scene_ts[j]) - ts_ns):
                j -= 1
            H = homographies.get(j)
        else:
            H = homographies.get(frame_i)
        if H is not None:
            pt = np.array([[[px, py]]], dtype=np.float32)
            mapped = cv2.perspectiveTransform(pt, H)
            px_p, py_p = float(mapped[0][0][0]), float(mapped[0][0][1])
            if 0 <= px_p <= 1 and 0 <= py_p <= 1:
                paper_x = px_p
                paper_y = py_p
                frames_on_paper += 1

        out_rows.append({
            "recording id": recording_id,
            "timestamp_ns": ts_ns,
            "pred_gaze_x": round(px, 2),
            "pred_gaze_y": round(py, 2),
            "paper_x": round(paper_x, 4) if paper_x is not None else None,
            "paper_y": round(paper_y, 4) if paper_y is not None else None,
        })

    import csv
    out_csv = gdir / "gaze_predictions.csv"
    with open(out_csv, "w", newline="") as f:
        # "recording id" leads so rows stay traceable once merged across recordings.
        writer = csv.DictWriter(
            f, fieldnames=["recording id", "timestamp_ns", "pred_gaze_x", "pred_gaze_y", "paper_x", "paper_y"],
        )
        writer.writeheader()
        writer.writerows(out_rows)

    db = await get_db()
    try:
        await db.execute(
            "UPDATE recordings SET has_gaze_result = 1 WHERE id = ?", (recording_id,)
        )
        await db.commit()
    finally:
        await db.close()

    result = {
        "mean_rmse": mean_rmse,                    # leave-one-out (honest)
        "mean_rmse_insample": mean_rmse_insample,  # in-sample (optimistic) — for reference
        "alpha": best_alpha,
        "degree": best_degree,
        "n_calib": len(merged),
        "frames_with_gaze": frames_with_gaze,
        "frames_on_paper": frames_on_paper,
        "total_frames": len(pupils),
        "residuals": residuals,
    }
    (gdir / "mapping_result.json").write_text(json.dumps(result, indent=2))
    return result


@router.get("/map/result")
async def get_map_result(recording_id: str):
    """Return the stats from the last completed gaze mapping, if any."""
    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])
    f = gdir / "mapping_result.json"
    if not f.exists():
        return None
    return json.loads(f.read_text())


# ── fixation detection (I-DT) ───────────────────────────────────────────────
# Scene-camera angular scale on Neon, validated against a real Pupil Cloud
# fixations.csv (15.1 px/deg horizontal, 15.8 vertical) → ~15.5 px/deg. Used to
# turn the dispersion threshold from degrees of visual angle into scene pixels.
_SCENE_PX_PER_DEG = 15.5


class FixationRequest(BaseModel):
    max_dispersion_deg: float = 1.5
    min_duration_ms: float = 80.0
    max_gap_ms: float = 100.0  # a longer sample gap (blink/loss) breaks a fixation


def _dispersion_px(xs: list, ys: list) -> float:
    """Salvucci & Goldberg dispersion of a window: (max_x-min_x) + (max_y-min_y)."""
    return (max(xs) - min(xs)) + (max(ys) - min(ys))


def _make_fixation(fix_id: int, members: list) -> dict:
    """Aggregate one fixation from its member 30-fps samples.

    Scene centroid is the median px (robust); the surface annotation is the mean
    of the members' paper coords, present only when the gaze fell on the surface.
    """
    ts = [m[0] for m in members]
    xs = [m[1] for m in members]
    ys = [m[2] for m in members]
    # paper_x/y in gaze_predictions.csv are set only when the gaze mapped inside
    # the surface ([0,1]²), so any non-None member is an on-surface sample.
    px = [m[3] for m in members if m[3] is not None and m[4] is not None]
    py = [m[4] for m in members if m[3] is not None and m[4] is not None]
    start_ts, end_ts = int(ts[0]), int(ts[-1])
    on_surface = len(px) >= max(1, len(members) / 2)
    return {
        "fixation_id": fix_id,
        "start_ts": start_ts,
        "end_ts": end_ts,
        "duration_ms": (end_ts - start_ts) / 1e6,
        "x_px": float(np.median(xs)),
        "y_px": float(np.median(ys)),
        "on_surface": on_surface,
        "norm_x": float(np.mean(px)) if px else None,
        "norm_y": float(np.mean(py)) if py else None,
        "n_samples": len(members),
    }


def _detect_fixations_idt(samples: list, disp_thresh_px: float, min_dur_ns: int, max_gap_ns: int) -> list:
    """I-DT dispersion algorithm (Salvucci & Goldberg) on scene-pixel gaze.

    `samples` is a time-ordered list of (ts_ns, x_px, y_px, paper_x|None,
    paper_y|None). Grows a window to the minimum duration, and if its spatial
    dispersion is within the threshold, keeps extending it until dispersion
    exceeds the bound or a sample gap is too large — then emits one fixation.

    No head-motion compensation (MVP): a long fixation spanning a head rotation
    will fragment, because the scene-pixel gaze drifts as the camera turns.
    """
    n = len(samples)
    ts = [s[0] for s in samples]
    xs = [s[1] for s in samples]
    ys = [s[2] for s in samples]
    fixations: list = []
    i = 0
    fix_id = 0
    while i < n:
        # grow [i, j) to at least the minimum duration, respecting sample gaps
        j = i + 1
        while j < n and (ts[j - 1] - ts[i]) < min_dur_ns:
            if ts[j] - ts[j - 1] > max_gap_ns:
                break
            j += 1
        if (ts[j - 1] - ts[i]) < min_dur_ns:
            i += 1
            continue
        if _dispersion_px(xs[i:j], ys[i:j]) > disp_thresh_px:
            i += 1
            continue
        # seed is a fixation: extend while it stays compact and gap-free
        while j < n:
            if ts[j] - ts[j - 1] > max_gap_ns:
                break
            if _dispersion_px(xs[i:j + 1], ys[i:j + 1]) > disp_thresh_px:
                break
            j += 1
        fix_id += 1
        fixations.append(_make_fixation(fix_id, samples[i:j]))
        i = j
    return fixations


@router.post("/fixations")
async def compute_fixations(recording_id: str, req: FixationRequest):
    import csv as csv_mod
    import uuid

    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])
    pred_csv = gdir / "gaze_predictions.csv"
    if not pred_csv.exists():
        raise HTTPException(status_code=400, detail="Run gaze mapping first")

    def _fp(v):
        return float(v) if v not in (None, "", "None", "null") else None

    samples = []
    with open(pred_csv) as f:
        for row in csv_mod.DictReader(f):
            samples.append((
                int(row["timestamp_ns"]),
                float(row["pred_gaze_x"]), float(row["pred_gaze_y"]),
                _fp(row.get("paper_x")), _fp(row.get("paper_y")),
            ))
    if len(samples) < 2:
        raise HTTPException(status_code=400, detail="Not enough gaze samples")
    samples.sort(key=lambda s: s[0])

    disp_px = req.max_dispersion_deg * _SCENE_PX_PER_DEG
    min_dur_ns = int(req.min_duration_ms * 1e6)
    max_gap_ns = int(req.max_gap_ms * 1e6)
    fixations = _detect_fixations_idt(samples, disp_px, min_dur_ns, max_gap_ns)

    # One default section per recording (stable across recomputes). Pupil uses a
    # section per enrichment/time-range; we have no segments yet, so span the whole
    # recording with a deterministic id derived from the recording id.
    section_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"fixations:{recording_id}"))

    with open(gdir / "fixations.csv", "w", newline="") as f:
        w = csv_mod.writer(f)
        w.writerow([
            "section id", "recording id", "fixation id",
            "start timestamp [ns]", "end timestamp [ns]", "duration [ms]",
            "fixation x [px]", "fixation y [px]",
        ])
        for fx in fixations:
            w.writerow([
                section_id, recording_id, fx["fixation_id"],
                fx["start_ts"], fx["end_ts"], round(fx["duration_ms"]),
                round(fx["x_px"], 3), round(fx["y_px"], 3),
            ])

    with open(gdir / "fixations_on_surface.csv", "w", newline="") as f:
        w = csv_mod.writer(f)
        w.writerow([
            "section id", "recording id", "fixation id",
            "start timestamp [ns]", "end timestamp [ns]", "duration [ms]",
            "fixation detected on surface",
            "fixation x [normalized]", "fixation y [normalized]",
        ])
        for fx in fixations:
            has_norm = fx["on_surface"] and fx["norm_x"] is not None
            w.writerow([
                section_id, recording_id, fx["fixation_id"],
                fx["start_ts"], fx["end_ts"], round(fx["duration_ms"]),
                fx["on_surface"],
                round(fx["norm_x"], 4) if has_norm else "",
                round(fx["norm_y"], 4) if has_norm else "",
            ])

    durs = [fx["duration_ms"] for fx in fixations]
    total_span = (samples[-1][0] - samples[0][0]) / 1e9
    n_on = sum(1 for fx in fixations if fx["on_surface"])
    result = {
        "n_fixations": len(fixations),
        "mean_duration_ms": float(np.mean(durs)) if durs else 0.0,
        "median_duration_ms": float(np.median(durs)) if durs else 0.0,
        "max_duration_ms": float(np.max(durs)) if durs else 0.0,
        "pct_time_fixating": float(sum(durs) / 1000 / total_span * 100) if total_span > 0 else 0.0,
        "n_on_surface": n_on,
        "pct_on_surface": float(n_on / len(fixations) * 100) if fixations else 0.0,
        "max_dispersion_deg": req.max_dispersion_deg,
        "min_duration_ms": req.min_duration_ms,
        "max_gap_ms": req.max_gap_ms,
    }
    (gdir / "fixations_result.json").write_text(json.dumps(result, indent=2))
    return result


@router.get("/fixations/result")
async def get_fixations_result(recording_id: str):
    """Summary stats from the last completed fixation detection, if any."""
    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])
    f = gdir / "fixations_result.json"
    if not f.exists():
        return None
    return json.loads(f.read_text())


@router.get("/fixations")
async def get_fixations(recording_id: str):
    """Fixations with both scene-px and (when available) surface coords, for overlays."""
    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])
    csv_path = gdir / "fixations.csv"
    if not csv_path.exists():
        return []

    import csv as csv_mod

    def _fp(v):
        return float(v) if v not in (None, "", "None", "null") else None

    surf: dict[str, dict] = {}
    surf_path = gdir / "fixations_on_surface.csv"
    if surf_path.exists():
        with open(surf_path) as f:
            for row in csv_mod.DictReader(f):
                surf[row["fixation id"]] = row

    rows = []
    with open(csv_path) as f:
        for row in csv_mod.DictReader(f):
            s = surf.get(row["fixation id"], {})
            rows.append({
                "fixation_id": int(row["fixation id"]),
                "start_ts_ns": int(row["start timestamp [ns]"]),
                "end_ts_ns": int(row["end timestamp [ns]"]),
                "duration_ms": float(row["duration [ms]"]),
                "x_px": float(row["fixation x [px]"]),
                "y_px": float(row["fixation y [px]"]),
                "on_surface": s.get("fixation detected on surface") == "True",
                "norm_x": _fp(s.get("fixation x [normalized]")),
                "norm_y": _fp(s.get("fixation y [normalized]")),
            })
    return rows


def _load_scene_timestamps(scene_path: str) -> np.ndarray:
    """Per-frame device timestamps (ns) from the scene camera's sibling .time file.

    One uint64 entry per video frame — the authoritative timestamp source for
    aligning scene frames to the gaze timeline. Returns an empty array if missing."""
    time_file = Path(scene_path).with_suffix(".time")
    if time_file.exists():
        return np.fromfile(str(time_file), dtype=np.uint64).astype(np.int64)
    return np.array([], dtype=np.int64)


def _build_homographies(scene_path: str, registry: Optional[dict]) -> tuple[np.ndarray, dict[int, np.ndarray]]:
    """Per-scene-frame scene→paper homographies from the AoI surface registry.

    Returns ``(scene_ts, homographies)`` where ``scene_ts[i]`` is the device
    timestamp (ns) of scene frame ``i`` and ``homographies[i]`` is that frame's
    scene→normalized-paper homography (only for frames where the surface is
    localizable). Callers match a gaze sample to a frame by NEAREST TIMESTAMP.

    The homography is built from the same marker registry (tag OUTER corners) the
    AoI editor warps onto, so mapped gaze shares the AoI coordinate system. Unlike
    the old approach it does NOT reuse a stale homography across frames where the
    surface is not visible, and works with any tag IDs / 3+ tags.
    """
    homographies: dict[int, np.ndarray] = {}
    scene_ts = _load_scene_timestamps(scene_path)
    if not registry or not _APRILTAG_AVAILABLE:
        return scene_ts, homographies

    detector = _make_apriltag_detector(_BULK_QUAD_DECIMATE, _BULK_NTHREADS)
    cap = cv2.VideoCapture(scene_path)
    frame_idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        dets = detector.detect(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
        H = _scene_to_paper_H(dets, registry)
        if H is not None:
            homographies[frame_idx] = H
        frame_idx += 1

    cap.release()
    return scene_ts, homographies


# ── predictions (for player overlay) ──────────────────────────────────────

@router.get("/predictions")
async def get_predictions(recording_id: str):
    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])
    csv_path = gdir / "gaze_predictions.csv"
    if not csv_path.exists():
        return []

    import csv
    rows = []
    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({
                "timestamp_ns": int(row["timestamp_ns"]),
                "pred_gaze_x": float(row["pred_gaze_x"]),
                "pred_gaze_y": float(row["pred_gaze_y"]),
                "paper_x": float(row["paper_x"]) if row["paper_x"] not in ("", "None", "null") else None,
                "paper_y": float(row["paper_y"]) if row["paper_y"] not in ("", "None", "null") else None,
            })
    return rows


@router.get("/pupils")
async def get_pupils(recording_id: str):
    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])
    csv_path = gdir / "pupils.csv"
    if not csv_path.exists():
        return []

    import csv as csv_mod
    import math

    def _safe(v: str):
        try:
            f = float(v)
            return None if math.isnan(f) else round(f, 2)
        except (ValueError, TypeError):
            return None

    rows = []
    with open(csv_path) as f:
        reader = csv_mod.DictReader(f)
        for row in reader:
            rows.append({
                "timestamp_ns": int(row["timestamp [ns]"]),
                "xL": _safe(row.get("xL", "")),
                "yL": _safe(row.get("yL", "")),
                "diameter_L": _safe(row.get("diameter_L", "")),
                "A_L": _safe(row.get("A_L", "")),
                "B_L": _safe(row.get("B_L", "")),
                "angle_L": _safe(row.get("angle_L", "")),
                "source_L": row.get("source_L", "") or None,
                "xR": _safe(row.get("xR", "")),
                "yR": _safe(row.get("yR", "")),
                "diameter_R": _safe(row.get("diameter_R", "")),
                "A_R": _safe(row.get("A_R", "")),
                "B_R": _safe(row.get("B_R", "")),
                "angle_R": _safe(row.get("angle_R", "")),
                "source_R": row.get("source_R", "") or None,
            })
    return rows
