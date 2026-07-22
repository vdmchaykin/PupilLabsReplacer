"""Pupil-format CSV export for a single recording or a whole project.

A project export concatenates each file across its recordings into one CSV. That
is only sound when a row can be traced back to its recording, so files that carry
no such column are declared unmergeable and offered for single recordings only —
see ExportSpec.id_column.
"""
import base64
import csv
import io
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.database import get_db

router = APIRouter(prefix="/api/export", tags=["export"])


@dataclass(frozen=True)
class ExportSpec:
    name: str          # exported filename, also its id in the API
    section: str       # the app section that produces it
    subdir: str        # location inside the recording folder ("" = root)
    todo: str          # what the user must do when it is missing
    id_column: Optional[str]  # column identifying the recording, None if the file has none yet


# surface_positions.csv has no "recording id" column, but its "section id" is
# written as the recording id (see aoi.start_surface_positions), so its rows stay
# traceable once merged.
SPECS: tuple = (
    ExportSpec("events.csv", "Events", "",
               "Mark events in the Events section", "recording id"),
    ExportSpec("pupils.csv", "Gaze", "gaze_analysis",
               "Run Step 1 — Pupil Detection in the Gaze section", "recording id"),
    ExportSpec("gaze_predictions.csv", "Gaze", "gaze_analysis",
               "Run Step 3 — Gaze Mapping in the Gaze section", "recording id"),
    ExportSpec("fixations.csv", "Gaze", "gaze_analysis",
               "Run Step 4 — Fixations in the Gaze section", "recording id"),
    ExportSpec("fixations_on_surface.csv", "Gaze", "gaze_analysis",
               "Run Step 4 — Fixations in the Gaze section", "recording id"),
    ExportSpec("surface_positions.csv", "Heatmap", "aoi",
               "Generate it in Heatmap → Surface positions", "section id"),
    ExportSpec("aoi_fixations.csv", "Heatmap", "aoi",
               "Generate it in Heatmap → AoI Fixations", "recording id"),
    ExportSpec("aoi_metrics.csv", "Heatmap", "aoi",
               "Generate it in Heatmap → AoI Fixations", "recording id"),
)

_BY_NAME = {s.name: s for s in SPECS}

# Shown in place of the download when a project export cannot merge a file.
_MERGE_UNSUPPORTED = (
    "This file has no recording id column yet, so rows could not be traced back "
    "after merging. Export it per recording for now."
)


def _spec(name: str) -> ExportSpec:
    spec = _BY_NAME.get(name)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unknown export file: {name}")
    return spec


def _path(rec: dict, spec: ExportSpec) -> Path:
    base = Path(rec["folder_path"])
    return base / spec.subdir / spec.name if spec.subdir else base / spec.name


def _has_rows(path: Path) -> bool:
    """Whether the file holds at least one data row.

    A header-only file is what a section leaves behind when it was opened but
    nothing was produced, so it counts as absent rather than as an export.
    """
    try:
        with open(path, newline="") as f:
            reader = csv.reader(f)
            if next(reader, None) is None:
                return False  # not even a header
            return any(any(cell.strip() for cell in row) for row in reader)
    except OSError:
        return False


async def _resolve(recording_id: Optional[str], project_id: Optional[str]) -> tuple:
    """(recordings, is_project, label) for the requested source."""
    if (recording_id is None) == (project_id is None):
        raise HTTPException(status_code=400, detail="Pass exactly one of recording_id or project_id")

    db = await get_db()
    try:
        if recording_id is not None:
            cur = await db.execute("SELECT * FROM recordings WHERE id = ?", (recording_id,))
            row = await cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Recording not found")
            rec = dict(row)
            return [rec], False, rec.get("name") or recording_id

        cur = await db.execute("SELECT name FROM projects WHERE id = ?", (project_id,))
        proj = await cur.fetchone()
        if not proj:
            raise HTTPException(status_code=404, detail="Project not found")
        cur = await db.execute(
            """SELECT r.* FROM recordings r
               JOIN project_recordings pr ON r.id = pr.recording_id
               WHERE pr.project_id = ?
               ORDER BY r.start_time""",
            (project_id,),
        )
        recs = [dict(r) for r in await cur.fetchall()]
        label = dict(proj).get("name") or project_id
    finally:
        await db.close()

    if not recs:
        raise HTTPException(status_code=400, detail="This project has no recordings")
    return recs, True, label


def _merge(recs: List[dict], spec: ExportSpec) -> bytes:
    """Concatenate the file across recordings under a single header.

    Refuses mismatched headers rather than silently writing ragged rows — that
    happens when files were produced by different versions of the pipeline.
    """
    out = io.StringIO()
    writer = None
    header: Optional[List[str]] = None

    for rec in recs:
        path = _path(rec, spec)
        if not _has_rows(path):
            continue
        with open(path, newline="") as f:
            reader = csv.reader(f)
            rows = iter(reader)
            head = next(rows, None)
            if head is None:
                continue
            if header is None:
                header = head
                writer = csv.writer(out)
                writer.writerow(header)
            elif head != header:
                raise HTTPException(
                    status_code=409,
                    detail=(f"{spec.name}: column layout differs between recordings — "
                            f"regenerate it for all of them and try again"),
                )
            for row in rows:
                writer.writerow(row)

    if header is None:
        raise HTTPException(status_code=404, detail=f"{spec.name} not available")
    return out.getvalue().encode()


def _availability(recs: List[dict], is_project: bool, spec: ExportSpec) -> dict:
    """Whether a file can be exported for this source, and why not if it can't."""
    missing = [r for r in recs if not _has_rows(_path(r, spec))]

    if is_project and spec.id_column is None:
        return {
            "available": False,
            "reason": _MERGE_UNSUPPORTED,
            "todo": None,
            "missing": [],
        }
    # A project export is all-or-nothing: a merged file that silently covers only
    # some recordings is worse than no file.
    if missing:
        return {
            "available": False,
            "reason": None,
            "todo": spec.todo,
            "missing": [{"id": r["id"], "name": r["name"]} for r in missing],
        }
    return {"available": True, "reason": None, "todo": None, "missing": []}


@router.get("/manifest")
async def manifest(recording_id: Optional[str] = None, project_id: Optional[str] = None):
    recs, is_project, _ = await _resolve(recording_id, project_id)
    return {
        "is_project": is_project,
        "n_recordings": len(recs),
        "files": [
            {
                "name": s.name,
                "section": s.section,
                "mergeable": s.id_column is not None,
                **_availability(recs, is_project, s),
            }
            for s in SPECS
        ],
    }


def _safe_name(stem: str) -> str:
    """Folder name derived from a recording/project name.

    Recording names carry colons ("2026-04-20_13:58:02") which are illegal on
    Windows and awkward everywhere — reduce to a conservative set."""
    cleaned = "".join(c if (c.isalnum() or c in "-_.") else "_" for c in stem).strip("_.")
    return cleaned or "export"


class SaveRequest(BaseModel):
    dest: str                            # folder chosen by the user in the OS dialog
    recording_id: Optional[str] = None
    project_id: Optional[str] = None
    names: Optional[List[str]] = None    # None = every available file
    create_folder: bool = False          # put the files in a subfolder named after the source
    overwrite: bool = False


@router.post("/save")
async def save_to_folder(req: SaveRequest):
    """Write the exported CSVs into a folder the user picked.

    The app runs in a Tauri webview, which has no browser download manager, so the
    frontend collects a destination via the OS dialog and the backend — already on
    the same machine — does the writing.
    """
    recs, is_project, label = await _resolve(req.recording_id, req.project_id)

    dest = Path(req.dest).expanduser()
    if not dest.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a folder: {dest}")

    if req.names is None:
        specs = [s for s in SPECS if _availability(recs, is_project, s)["available"]]
        if not specs:
            raise HTTPException(status_code=400, detail="Nothing to export yet")
    else:
        specs = [_spec(n) for n in req.names]
        for s in specs:
            avail = _availability(recs, is_project, s)
            if not avail["available"]:
                raise HTTPException(status_code=400, detail=avail["reason"] or avail["todo"])

    # Exporting a whole set drops it in its own folder, so the picked directory
    # doesn't end up littered with loose CSVs from several recordings.
    if req.create_folder:
        dest = dest / _safe_name(label)

    # Never clobber files already sitting in the user's folder without asking —
    # the picked folder is theirs and may hold unrelated data with these names.
    if not req.overwrite:
        clashes = [s.name for s in specs if (dest / s.name).exists()]
        if clashes:
            raise HTTPException(
                status_code=409,
                detail={"conflicts": clashes, "dest": str(dest)},
            )

    dest.mkdir(parents=True, exist_ok=True)

    written = []
    for spec in specs:
        (dest / spec.name).write_bytes(_merge(recs, spec))
        written.append(spec.name)

    return {"dest": str(dest), "written": written}


class SaveImageRequest(BaseModel):
    dest: str
    image_b64: str


@router.post("/save-image")
async def save_image(req: SaveImageRequest):
    """Write a client-rendered PNG (e.g. a Visualisation figure) to a picked path.

    The canvas is composited in the webview, so — like the CSV export — the
    frontend hands over a destination from the OS save dialog and the backend
    writes the bytes. The native dialog already confirms any overwrite.
    """
    dest = Path(req.dest).expanduser()
    if dest.suffix.lower() != ".png":
        dest = dest.with_suffix(".png")
    if not dest.parent.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a folder: {dest.parent}")

    data = req.image_b64
    if "," in data:
        data = data.split(",", 1)[1]  # tolerate a data: URL prefix
    try:
        raw = base64.b64decode(data)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image data")

    dest.write_bytes(raw)
    return {"dest": str(dest)}
