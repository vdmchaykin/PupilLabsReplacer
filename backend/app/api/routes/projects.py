import uuid
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional

from app.database import get_db

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None


class ProjectOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    created_at: Optional[str] = None
    recording_count: int = 0


class AddRecordingRequest(BaseModel):
    recording_id: str


@router.get("", response_model=List[ProjectOut])
async def list_projects():
    db = await get_db()
    try:
        cursor = await db.execute("""
            SELECT p.*, COUNT(pr.recording_id) as recording_count
            FROM projects p
            LEFT JOIN project_recordings pr ON p.id = pr.project_id
            GROUP BY p.id
            ORDER BY p.created_at DESC
        """)
        rows = await cursor.fetchall()
    finally:
        await db.close()
    return [ProjectOut(**dict(row)) for row in rows]


@router.post("", response_model=ProjectOut)
async def create_project(body: ProjectCreate):
    project_id = str(uuid.uuid4())
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO projects (id, name, description) VALUES (?, ?, ?)",
            (project_id, body.name, body.description),
        )
        await db.commit()
        cursor = await db.execute(
            "SELECT *, 0 as recording_count FROM projects WHERE id = ?", (project_id,)
        )
        row = await cursor.fetchone()
    finally:
        await db.close()
    return ProjectOut(**dict(row))


@router.delete("/{project_id}")
async def delete_project(project_id: str):
    db = await get_db()
    try:
        cursor = await db.execute("SELECT id FROM projects WHERE id = ?", (project_id,))
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Project not found")
        await db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        await db.commit()
    finally:
        await db.close()
    return {"deleted": project_id}


@router.get("/{project_id}/recordings")
async def get_project_recordings(project_id: str):
    db = await get_db()
    try:
        cursor = await db.execute("""
            SELECT r.* FROM recordings r
            JOIN project_recordings pr ON r.id = pr.recording_id
            WHERE pr.project_id = ?
        """, (project_id,))
        rows = await cursor.fetchall()
    finally:
        await db.close()
    result = []
    for row in rows:
        d = dict(row)
        if d.get("duration_ns"):
            d["duration_sec"] = d["duration_ns"] / 1_000_000_000
        d["has_gaze_result"] = bool(d.get("has_gaze_result"))
        result.append(d)
    return result


@router.post("/{project_id}/recordings")
async def add_recording(project_id: str, body: AddRecordingRequest):
    db = await get_db()
    try:
        cursor = await db.execute("SELECT id FROM projects WHERE id = ?", (project_id,))
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Project not found")
        cursor = await db.execute(
            "SELECT id FROM recordings WHERE id = ?", (body.recording_id,)
        )
        if not await cursor.fetchone():
            raise HTTPException(status_code=404, detail="Recording not found")
        await db.execute(
            "INSERT OR IGNORE INTO project_recordings (project_id, recording_id) VALUES (?, ?)",
            (project_id, body.recording_id),
        )
        await db.commit()
    finally:
        await db.close()
    return {"added": body.recording_id}


@router.delete("/{project_id}/recordings/{recording_id}")
async def remove_recording(project_id: str, recording_id: str):
    db = await get_db()
    try:
        await db.execute(
            "DELETE FROM project_recordings WHERE project_id = ? AND recording_id = ?",
            (project_id, recording_id),
        )
        await db.commit()
    finally:
        await db.close()
    return {"removed": recording_id}
