import json
import sys
import threading
from pathlib import Path
from typing import Optional  # noqa: F401 — used in _build_homographies
import cv2
import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.database import get_db

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


def _gaze_dir(folder_path: str) -> Path:
    d = Path(folder_path) / "gaze_analysis"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── state ──────────────────────────────────────────────────────────────────

def _gaze_state_dict(gdir: Path) -> dict:
    calib_file = gdir / "calibration_points.json"
    calibration_done = calib_file.exists()
    calibration_points = json.loads(calib_file.read_text()) if calibration_done else []
    return {
        "pupils_done": (gdir / "pupils.csv").exists(),
        "calibration_done": calibration_done,
        "mapping_done": (gdir / "gaze_predictions.csv").exists(),
        "calibration_points": calibration_points,
    }


# Files produced by each stage, including everything downstream that becomes
# invalid once the stage's data is removed (deleting pupils invalidates the
# calibration matching and the mapping, etc.).
_STAGE_FILES: dict[str, list[str]] = {
    "pupils": ["pupils.csv", "pupils_30fps.csv", "detection_stats.json", "calibration_points.json", "gaze_predictions.csv", "mapping_result.json"],
    "calibration": ["calibration_points.json", "gaze_predictions.csv", "mapping_result.json"],
    "mapping": ["gaze_predictions.csv", "mapping_result.json"],
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
    # Floodfill (primary) detector knobs. Edge-fallback params keep library defaults.
    heatmap_roi_size: int = 35
    floodfill_lo_diff: int = 25
    floodfill_hi_diff: int = 15
    floodfill_blur_ksize: int = 3
    floodfill_min_area: float = 40.0
    floodfill_min_fill_frac: float = 0.55
    floodfill_max_aspect: float = 1.8
    floodfill_seed_search: int = 10
    floodfill_lash_open_ksize: int = 9


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
        floodfill_cfg = DetectorConfig(
            heatmap_roi_size=cfg.heatmap_roi_size,
            floodfill_lo_diff=cfg.floodfill_lo_diff,
            floodfill_hi_diff=cfg.floodfill_hi_diff,
            floodfill_blur_ksize=cfg.floodfill_blur_ksize,
            floodfill_min_area=cfg.floodfill_min_area,
            floodfill_min_fill_frac=cfg.floodfill_min_fill_frac,
            floodfill_max_aspect=cfg.floodfill_max_aspect,
            floodfill_seed_search=cfg.floodfill_seed_search,
            floodfill_lash_open_ksize=cfg.floodfill_lash_open_ksize,
        )
        edge_cfg = EdgeDetectorConfig(
            heatmap_roi_size=cfg.heatmap_roi_size,
            circle_fit_min_radius=6.0,
            circle_fit_max_radius=15.0,
        )
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

        _FIELDNAMES = [
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
    scene_path = rec.get("scene_video")
    homographies = _build_homographies(scene_path) if scene_path else {}

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
            "timestamp_ns": ts_ns,
            "pred_gaze_x": round(px, 2),
            "pred_gaze_y": round(py, 2),
            "paper_x": round(paper_x, 4) if paper_x is not None else None,
            "paper_y": round(paper_y, 4) if paper_y is not None else None,
        })

    import csv
    out_csv = gdir / "gaze_predictions.csv"
    with open(out_csv, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["timestamp_ns", "pred_gaze_x", "pred_gaze_y", "paper_x", "paper_y"])
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


def _build_homographies(scene_path: str) -> dict[int, np.ndarray]:
    """Detect AprilTag markers and build per-frame homographies."""
    homographies: dict[int, np.ndarray] = {}
    try:
        aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_APRILTAG_36h11)
        params = cv2.aruco.DetectorParameters()
        detector = cv2.aruco.ArucoDetector(aruco_dict, params)
    except Exception:
        return homographies

    # Tag corners in normalized paper coords: TL, TR, BR, BL
    TAG_PAPER = {
        0: np.array([[0, 0]], dtype=np.float32),
        1: np.array([[1, 0]], dtype=np.float32),
        2: np.array([[1, 1]], dtype=np.float32),
        3: np.array([[0, 1]], dtype=np.float32),
    }

    cap = cv2.VideoCapture(scene_path)
    frame_idx = 0
    last_H: Optional[np.ndarray] = None

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        corners, ids, _ = detector.detectMarkers(gray)

        if ids is not None and len(ids) >= 4:
            src_pts = []
            dst_pts = []
            for corner, tag_id in zip(corners, ids.flatten()):
                if tag_id in TAG_PAPER:
                    center = corner[0].mean(axis=0)
                    src_pts.append(center)
                    dst_pts.append(TAG_PAPER[tag_id][0])
            if len(src_pts) >= 4:
                H, _ = cv2.findHomography(
                    np.array(src_pts, dtype=np.float32),
                    np.array(dst_pts, dtype=np.float32),
                )
                if H is not None:
                    last_H = H

        if last_H is not None:
            homographies[frame_idx] = last_H

        frame_idx += 1

    cap.release()
    return homographies


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
