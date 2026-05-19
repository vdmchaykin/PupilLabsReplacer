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

@router.get("/state")
async def get_gaze_state(recording_id: str):
    rec = await _get_recording(recording_id)
    gdir = _gaze_dir(rec["folder_path"])

    pupils_done = (gdir / "pupils.csv").exists()
    calib_file = gdir / "calibration_points.json"
    calibration_done = calib_file.exists()
    calibration_points = []
    if calibration_done:
        calibration_points = json.loads(calib_file.read_text())

    mapping_done = (gdir / "gaze_predictions.csv").exists()

    return {
        "pupils_done": pupils_done,
        "calibration_done": calibration_done,
        "mapping_done": mapping_done,
        "calibration_points": calibration_points,
    }


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
    canny_low: int = 50
    canny_high: int = 100
    min_ellipse_area: int = 250
    heatmap_roi_size: int = 30


def _fmt(v: float) -> str:
    import math
    return "" if math.isnan(v) else f"{v:.3f}"


def _effective_xy(pupil_cx: float, pupil_cy: float, heatmap_cx: float, heatmap_cy: float):
    """Return (x, y) — heatmap fallback when ellipse detection failed."""
    import math
    if not math.isnan(pupil_cx):
        return pupil_cx, pupil_cy
    if not math.isnan(heatmap_cx):
        return heatmap_cx, heatmap_cy
    return float("nan"), float("nan")


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


def _run_pupil_detection(recording_id: str, eye_path: str, folder_path: str, out_csv: Path, cfg: DetectRequest):
    import math
    import csv as csv_mod

    job = _detect_jobs[recording_id]
    job["status"] = "running"

    try:
        import sys as _sys
        if _GAZE_SITE not in _sys.path:
            _sys.path.insert(0, _GAZE_SITE)

        from pipeline.pupil_detector import PupilDetector, DetectorConfig, FrameContext

        if not Path(_HEATMAP_CKPT).exists():
            raise FileNotFoundError(f"HeatmapNet checkpoint not found: {_HEATMAP_CKPT}")

        job["message"] = "Loading HeatmapNet model…"
        det_cfg = DetectorConfig(
            video=eye_path,
            canny_low=cfg.canny_low,
            canny_high=cfg.canny_high,
            min_ellipse_area=cfg.min_ellipse_area,
            heatmap_ckpt=_HEATMAP_CKPT,
            heatmap_roi_size=cfg.heatmap_roi_size,
        )
        detector = PupilDetector(det_cfg)

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

        # Use real device timestamps if available, fall back to frame index
        device_timestamps = _load_timestamps(folder_path)

        ctx_l = FrameContext(frame_idx=0, roi_rect=roi_l)
        ctx_r = FrameContext(frame_idx=0, roi_rect=roi_r)

        _FIELDNAMES = [
            "timestamp [ns]",
            "xL", "yL", "diameter_L", "confidence_L",
            "xR", "yR", "diameter_R", "confidence_R",
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

                ctx_l.frame_idx = frame_idx
                ctx_r.frame_idx = frame_idx

                if frame_idx < len(device_timestamps):
                    timestamp_ns = device_timestamps[frame_idx]
                else:
                    timestamp_ns = int((frame_idx / fps) * 1e9)

                try:
                    detector.process(left, ctx_l)
                except Exception:
                    pass
                try:
                    detector.process(right, ctx_r)
                except Exception:
                    pass

                xL, yL = _effective_xy(ctx_l.pupil_cx, ctx_l.pupil_cy,
                                       ctx_l.heatmap_cx, ctx_l.heatmap_cy)
                xR, yR = _effective_xy(ctx_r.pupil_cx, ctx_r.pupil_cy,
                                       ctx_r.heatmap_cx, ctx_r.heatmap_cy)

                writer.writerow({
                    "timestamp [ns]": timestamp_ns,
                    "xL": _fmt(xL), "yL": _fmt(yL),
                    "diameter_L": _fmt(ctx_l.pupil_diameter),
                    "confidence_L": _fmt(ctx_l.pupil_confidence),
                    "xR": _fmt(xR), "yR": _fmt(yR),
                    "diameter_R": _fmt(ctx_r.pupil_diameter),
                    "confidence_R": _fmt(ctx_r.pupil_confidence),
                })

                if not math.isnan(ctx_l.pupil_confidence):
                    conf_sum += ctx_l.pupil_confidence
                    conf_count += 1
                if not math.isnan(ctx_r.pupil_confidence):
                    conf_sum += ctx_r.pupil_confidence
                    conf_count += 1

                frame_idx += 1
                job["progress"] = frame_idx

        cap.release()

        mean_conf = conf_sum / conf_count if conf_count else 0.0
        job["mean_confidence"] = mean_conf
        job["status"] = "done" if not job.get("cancelled") else "idle"

        if not job.get("cancelled"):
            stats_file = out_csv.parent / "detection_stats.json"
            import json as _json
            stats_file.write_text(_json.dumps({"mean_confidence": mean_conf}))

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

    TARGET_FPS = 30
    COLS_L = ["xL", "yL", "diameter_L", "confidence_L"]
    COLS_R = ["xR", "yR", "diameter_R", "confidence_R"]

    # ── 1. Load raw high-fps pupil data ────────────────────────────────────
    pupils_raw = pd.read_csv(pupils_csv)
    pupils_raw = pupils_raw.rename(columns={"timestamp [ns]": "timestamp_ns"})
    for col in COLS_L + COLS_R:
        pupils_raw[col] = pd.to_numeric(pupils_raw[col], errors="coerce")

    # ── 2. Downsample to 30 fps (timestamp-aligned, confidence-weighted) ───
    ts_eye_csv = Path(folder_path) / "csv" / "timestamps.csv"
    if ts_eye_csv.exists():
        ts_eye = pd.read_csv(ts_eye_csv)
        _ts_col = next((c for c in ts_eye.columns if "timestamp" in c.lower()), None)
        t0 = int(ts_eye[_ts_col].iloc[0])
        t1 = int(ts_eye[_ts_col].iloc[-1])
    else:
        t0 = int(pupils_raw["timestamp_ns"].iloc[0])
        t1 = int(pupils_raw["timestamp_ns"].iloc[-1])

    n_scene = max(1, round((t1 - t0) / 1e9 * TARGET_FPS))
    half_win = int(1e9 / TARGET_FPS / 2)
    scene_ts = np.linspace(t0, t1, n_scene, dtype=np.int64)
    pupil_ts_arr = pupils_raw["timestamp_ns"].to_numpy(np.int64)

    def _weighted_avg(chunk: pd.DataFrame, cols: list) -> dict:
        conf_col = cols[3]
        valid = chunk[cols].copy()
        has_conf = valid[conf_col].notna()
        if has_conf.any():
            valid = valid[has_conf]
            w = valid[conf_col].to_numpy()
            w = w / w.sum()
            result = {c: float((valid[c] * w).sum()) for c in cols[:3]}
            result[conf_col] = float(valid[conf_col].mean())
        elif len(valid) > 0:
            result = {c: float(valid[c].mean()) for c in cols[:3]}
            result[conf_col] = np.nan
        else:
            result = {c: np.nan for c in cols}
        return result

    ds_rows = []
    for t in scene_ts:
        mask = np.abs(pupil_ts_arr - t) <= half_win
        chunk = pupils_raw[mask]
        row: dict = {"timestamp_ns": t}
        row.update(_weighted_avg(chunk, COLS_L))
        row.update(_weighted_avg(chunk, COLS_R))
        ds_rows.append(row)

    pupils = pd.DataFrame(ds_rows, columns=["timestamp_ns"] + COLS_L + COLS_R)

    # Mirror left eye x (sensor is physically mirrored)
    pupils["xL"] = 192 - pupils["xL"]

    # ── 3. Derived features ────────────────────────────────────────────────
    pupils["xm"] = (pupils["xL"] + pupils["xR"]) / 2
    pupils["ym"] = (pupils["yL"] + pupils["yR"]) / 2
    pupils["dx"] = pupils["xR"] - pupils["xL"]
    pupils["dy"] = pupils["yR"] - pupils["yL"]

    base_features = ["xL", "yL", "xR", "yR", "xm", "ym", "dx", "dy"]

    # ── 4. IMU features (optional) ─────────────────────────────────────────
    imu_features: list[str] = []
    imu_csv_path = Path(folder_path) / "csv" / "imu.csv"
    if imu_csv_path.exists():
        imu_df = pd.read_csv(imu_csv_path)
        _imu_ts_col = next((c for c in imu_df.columns if "timestamp" in c.lower()), None)
        _imu_q_cols = ["quat_w", "quat_x", "quat_y", "quat_z"]
        if _imu_ts_col and all(c in imu_df.columns for c in _imu_q_cols):
            t_pupil = pupils["timestamp_ns"].to_numpy(np.float64)
            t_imu = imu_df[_imu_ts_col].to_numpy(np.float64)
            q = np.column_stack([
                np.interp(t_pupil, t_imu, imu_df[c].to_numpy(np.float64))
                for c in _imu_q_cols
            ])
            norms = np.linalg.norm(q, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            q /= norms
            pupils[["imu_qw", "imu_qx", "imu_qy", "imu_qz"]] = q
            imu_features = ["imu_qw", "imu_qx", "imu_qy", "imu_qz"]

    all_features = base_features + imu_features

    # ── 5. Match calibration points to nearest valid 30-fps frame ──────────
    valid_mask = pupils[base_features].notna().all(axis=1)
    pupils_valid = pupils[valid_mask].reset_index(drop=True)

    if len(pupils_valid) == 0:
        raise HTTPException(status_code=400, detail="No valid pupil detections found")

    calib_points = json.loads(calib_json.read_text())
    if not calib_points:
        raise HTTPException(status_code=400, detail="No calibration points")

    # Frontend saves timestamp_ns = seekTime * 1e9 (seconds from scene video start).
    # Scene and eye cameras are hardware-synced on Neon: both cover [t0, t1].
    # Pipeline equivalent: scene_timestamps = np.linspace(t0, t1, n_scene)
    # → scene frame at seekTime maps to absolute timestamp t0 + seekTime_ns.
    merged_rows = []
    for cp in calib_points:
        ts = t0 + cp["timestamp_ns"]
        idx = (pupils_valid["timestamp_ns"] - ts).abs().idxmin()
        pupil_row = pupils_valid.loc[idx]
        merged_rows.append({
            **{f: pupil_row[f] for f in all_features},
            "gaze_x": cp["gaze_x"],
            "gaze_y": cp["gaze_y"],
        })

    merged = pd.DataFrame(merged_rows).dropna(subset=base_features)
    if len(merged) == 0:
        raise HTTPException(status_code=400, detail="Calibration points have no matching valid pupil data")

    X_train = merged[all_features].to_numpy(np.float64)
    y_train = merged[["gaze_x", "gaze_y"]].to_numpy(np.float64)

    # ── 6. Train polynomial Ridge model ────────────────────────────────────
    model = SkPipeline([
        ("poly", PolynomialFeatures(degree=2, include_bias=False)),
        ("ridge", Ridge(alpha=10.0)),
    ])
    model.fit(X_train, y_train)

    # ── 7. Residuals on calibration points ─────────────────────────────────
    y_pred_train = model.predict(X_train)
    residuals = []
    for i, cp in enumerate(calib_points):
        err = float(np.linalg.norm(y_pred_train[i] - y_train[i]))
        residuals.append({
            "point_id": cp["point_id"],
            "true_x": float(y_train[i][0]),
            "true_y": float(y_train[i][1]),
            "pred_x": float(y_pred_train[i][0]),
            "pred_y": float(y_pred_train[i][1]),
            "error_px": err,
        })
    mean_rmse = float(np.mean([r["error_px"] for r in residuals]))

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

    return {
        "mean_rmse": mean_rmse,
        "frames_with_gaze": frames_with_gaze,
        "frames_on_paper": frames_on_paper,
        "total_frames": len(pupils),
        "residuals": residuals,
    }


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
                "xR": _safe(row.get("xR", "")),
                "yR": _safe(row.get("yR", "")),
                "diameter_R": _safe(row.get("diameter_R", "")),
            })
    return rows
