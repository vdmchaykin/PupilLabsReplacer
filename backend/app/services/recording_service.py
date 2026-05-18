import json
import sys
import zipfile
import shutil
from pathlib import Path
from typing import Optional

RECORDINGS_DIR = Path(__file__).parent.parent.parent.parent / "data" / "recordings"

_GAZE_EST_DIR = Path(__file__).parent.parent.parent.parent.parent.parent / "Gaze_estimation"
_GAZE_ENV_SITE = str(_GAZE_EST_DIR / "gaze_env" / "lib" / "python3.12" / "site-packages")


def _find_file(folder: Path, pattern: str) -> Optional[Path]:
    matches = list(folder.glob(pattern)) or list(folder.glob(f"**/{pattern}"))
    return matches[0] if matches else None


def _extract_zip_flat(zip_path: Path, dest: Path) -> None:
    """Extract zip into dest, stripping the top-level folder if present."""
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.infolist():
            if member.is_dir():
                continue
            parts = Path(member.filename).parts
            relative = Path(*parts[1:]) if len(parts) > 1 else Path(parts[0])
            target = dest / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(member) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)


def _run_convert_to_csv(recording_dir: Path) -> None:
    """Convert Neon binary files to CSV. Output is always placed in recording_dir/csv/."""
    for p in (_GAZE_ENV_SITE, str(_GAZE_EST_DIR)):
        if p not in sys.path:
            sys.path.insert(0, p)
    from pipeline.convert_to_csv import convert_recording

    _MARKER_FILES = ["gaze ps1.raw", "imu ps1.raw", "event.txt"]

    def _has_recording_files(d: Path) -> bool:
        return any((d / f).exists() for f in _MARKER_FILES)

    if _has_recording_files(recording_dir):
        convert_recording(str(recording_dir))
    else:
        subdirs = [d for d in recording_dir.iterdir() if d.is_dir() and _has_recording_files(d)]
        if not subdirs:
            raise ValueError(f"No Neon recording files found in {recording_dir}")
        for sub in subdirs:
            convert_recording(str(sub))
            # Move generated csv/ up to recording_dir/csv/ so paths are consistent
            sub_csv = sub / "csv"
            top_csv = recording_dir / "csv"
            if sub_csv.exists():
                if top_csv.exists():
                    shutil.rmtree(top_csv)
                shutil.move(str(sub_csv), str(top_csv))


def import_recording(native_zip_path: str) -> dict:
    """Import recording from a single Native Recording Data zip."""
    native_zip = Path(native_zip_path)

    if not native_zip.exists():
        raise FileNotFoundError(f"ZIP not found: {native_zip}")

    with zipfile.ZipFile(native_zip) as zf:
        names = zf.namelist()
        info_name = next((n for n in names if n.endswith("info.json")), None)
        if not info_name:
            raise ValueError("Not a valid Native Recording zip: info.json missing")

        info = json.loads(zf.read(info_name))
        recording_id = info.get("recording_id", "")
        if not recording_id:
            raise ValueError("info.json has no recording_id")

        wearer_name = info.get("wearer_name")
        if not wearer_name:
            wearer_name_file = next((n for n in names if n.endswith("wearer.json")), None)
            if wearer_name_file:
                wearer = json.loads(zf.read(wearer_name_file))
                wearer_name = wearer.get("name")

    dest = RECORDINGS_DIR / recording_id
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)

    _extract_zip_flat(native_zip, dest)

    # Convert binary Neon files to CSV
    try:
        _run_convert_to_csv(dest)
    except Exception as e:
        raise ValueError(f"CSV conversion failed: {e}") from e

    scene_video = _find_file(dest, "*Scene Camera*.mp4")
    eye_video = _find_file(dest, "*Sensor Module*.mp4")
    has_gaze = (dest / "csv" / "gaze.csv").exists()

    duration_ns = info.get("duration")
    duration_sec = duration_ns / 1_000_000_000 if duration_ns else None

    return {
        "id": recording_id,
        "name": info.get("template_data", {}).get("recording_name", recording_id),
        "wearer_name": wearer_name,
        "start_time": info.get("start_time"),
        "duration_ns": duration_ns,
        "duration_sec": duration_sec,
        "gaze_frequency": info.get("gaze_frequency"),
        "device_serial": info.get("module_serial_number"),
        "app_version": info.get("app_version"),
        "folder_path": str(dest),
        "scene_video": str(scene_video) if scene_video else None,
        "eye_video": str(eye_video) if eye_video else None,
        "has_gaze_result": has_gaze,
    }
