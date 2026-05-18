from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import List
import os

from app.database import get_db
from app.models.recording import RecordingMeta
from app.services.recording_service import import_recording as _import_recording

router = APIRouter(prefix="/api/recordings", tags=["recordings"])


class ImportRequest(BaseModel):
    native_zip_path: str


@router.post("/import", response_model=RecordingMeta)
async def import_recording(req: ImportRequest):
    try:
        meta = _import_recording(req.native_zip_path)
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    db = await get_db()
    try:
        await db.execute("""
            INSERT OR REPLACE INTO recordings
            (id, name, wearer_name, start_time, duration_ns, gaze_frequency,
             device_serial, app_version, folder_path, scene_video, eye_video,
             has_gaze_result)
            VALUES (:id, :name, :wearer_name, :start_time, :duration_ns,
                    :gaze_frequency, :device_serial, :app_version,
                    :folder_path, :scene_video, :eye_video, :has_gaze_result)
        """, meta)
        await db.commit()
    finally:
        await db.close()

    return RecordingMeta(**meta)


@router.get("", response_model=List[RecordingMeta])
async def list_recordings():
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM recordings ORDER BY imported_at DESC")
        rows = await cursor.fetchall()
    finally:
        await db.close()

    result = []
    for row in rows:
        d = dict(row)
        if d.get("duration_ns"):
            d["duration_sec"] = d["duration_ns"] / 1_000_000_000
        d["has_gaze_result"] = bool(d.get("has_gaze_result"))
        result.append(RecordingMeta(**d))
    return result


@router.get("/{recording_id}", response_model=RecordingMeta)
async def get_recording(recording_id: str):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM recordings WHERE id = ?", (recording_id,)
        )
        row = await cursor.fetchone()
    finally:
        await db.close()

    if not row:
        raise HTTPException(status_code=404, detail="Recording not found")

    d = dict(row)
    if d.get("duration_ns"):
        d["duration_sec"] = d["duration_ns"] / 1_000_000_000
    d["has_gaze_result"] = bool(d.get("has_gaze_result"))
    return RecordingMeta(**d)


@router.delete("/{recording_id}")
async def delete_recording(recording_id: str):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT folder_path FROM recordings WHERE id = ?", (recording_id,)
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Recording not found")
        await db.execute("DELETE FROM recordings WHERE id = ?", (recording_id,))
        await db.commit()
    finally:
        await db.close()
    return {"deleted": recording_id}


@router.get("/{recording_id}/video/{video_type}")
async def stream_video(recording_id: str, video_type: str):
    """Stream scene or eye video. video_type: 'scene' or 'eye'"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT scene_video, eye_video FROM recordings WHERE id = ?",
            (recording_id,)
        )
        row = await cursor.fetchone()
    finally:
        await db.close()

    if not row:
        raise HTTPException(status_code=404, detail="Recording not found")

    path = row["scene_video"] if video_type == "scene" else row["eye_video"]
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"{video_type} video not found")

    return FileResponse(path, media_type="video/mp4")
