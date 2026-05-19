from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List
import os
import csv

from app.database import get_db

router = APIRouter(prefix="/api/recordings", tags=["events"])


class EventCreate(BaseModel):
    timestamp_s: float
    name: str


class EventUpdate(BaseModel):
    name: str


class EventOut(BaseModel):
    index: int
    timestamp_s: float
    name: str


def _events_path(folder_path: str) -> str:
    return os.path.join(folder_path, "events.csv")


def _read_events(folder_path: str) -> List[dict]:
    path = _events_path(folder_path)
    if not os.path.exists(path):
        return []
    events = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                ts = float(row.get("timestamp_s", 0))
            except (ValueError, TypeError):
                ts = 0.0
            events.append({"timestamp_s": ts, "name": row.get("name", "")})
    return events


def _write_events(folder_path: str, events: List[dict]):
    path = _events_path(folder_path)
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["timestamp_s", "name"])
        writer.writeheader()
        for e in events:
            writer.writerow({"timestamp_s": e["timestamp_s"], "name": e["name"]})


async def _get_folder(recording_id: str) -> str:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT folder_path FROM recordings WHERE id = ?", (recording_id,)
        )
        row = await cursor.fetchone()
    finally:
        await db.close()
    if not row:
        raise HTTPException(status_code=404, detail="Recording not found")
    return row["folder_path"]


@router.get("/{recording_id}/events", response_model=List[EventOut])
async def get_events(recording_id: str):
    folder = await _get_folder(recording_id)
    events = _read_events(folder)
    return [EventOut(index=i, **e) for i, e in enumerate(events)]


@router.post("/{recording_id}/events", response_model=List[EventOut])
async def add_event(recording_id: str, body: EventCreate):
    folder = await _get_folder(recording_id)
    events = _read_events(folder)
    events.append({"timestamp_s": body.timestamp_s, "name": body.name})
    events.sort(key=lambda e: e["timestamp_s"])
    _write_events(folder, events)
    return [EventOut(index=i, **e) for i, e in enumerate(events)]


@router.put("/{recording_id}/events/{index}", response_model=List[EventOut])
async def update_event(recording_id: str, index: int, body: EventUpdate):
    folder = await _get_folder(recording_id)
    events = _read_events(folder)
    if index < 0 or index >= len(events):
        raise HTTPException(status_code=404, detail="Event not found")
    events[index]["name"] = body.name
    _write_events(folder, events)
    return [EventOut(index=i, **e) for i, e in enumerate(events)]


@router.delete("/{recording_id}/events/{index}", response_model=List[EventOut])
async def delete_event(recording_id: str, index: int):
    folder = await _get_folder(recording_id)
    events = _read_events(folder)
    if index < 0 or index >= len(events):
        raise HTTPException(status_code=404, detail="Event not found")
    events.pop(index)
    _write_events(folder, events)
    return [EventOut(index=i, **e) for i, e in enumerate(events)]
