import json
import zipfile
import shutil
from pathlib import Path
from typing import Optional

RECORDINGS_DIR = Path(__file__).parent.parent.parent.parent / "data" / "recordings"


def _find_file(folder: Path, pattern: str) -> Optional[Path]:
    matches = list(folder.glob(pattern))
    return matches[0] if matches else None


def import_native_zip(zip_path: str) -> dict:
    """Extract Native Recording Data zip and return parsed metadata."""
    zip_path = Path(zip_path)
    if not zip_path.exists():
        raise FileNotFoundError(f"ZIP not found: {zip_path}")

    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()

        # find info.json inside the zip (may be nested in a subfolder)
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

        # Extract to recordings dir
        dest = RECORDINGS_DIR / recording_id
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        zf.extractall(dest)

    # After extraction, find the actual content folder (zip may have a subfolder)
    content_dirs = [d for d in dest.iterdir() if d.is_dir()]
    base = content_dirs[0] if content_dirs else dest

    scene_video = _find_file(base, "*Scene Camera*.mp4")
    eye_video = _find_file(base, "*Sensor Module*.mp4")

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
    }
