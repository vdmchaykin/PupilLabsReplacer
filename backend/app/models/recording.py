from pydantic import BaseModel
from typing import List, Optional


class ProjectRef(BaseModel):
    id: str
    name: str


class RecordingMeta(BaseModel):
    id: str
    name: str
    wearer_name: Optional[str] = None
    start_time: Optional[int] = None
    duration_ns: Optional[int] = None
    duration_sec: Optional[float] = None
    gaze_frequency: Optional[int] = None
    device_serial: Optional[str] = None
    app_version: Optional[str] = None
    folder_path: str
    scene_video: Optional[str] = None
    eye_video: Optional[str] = None
    has_gaze_result: bool = False
    imported_at: Optional[str] = None
    projects: List[ProjectRef] = []
