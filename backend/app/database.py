import aiosqlite
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "data" / "app.db"


async def get_db() -> aiosqlite.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


async def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS recordings (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                wearer_name TEXT,
                start_time INTEGER,
                duration_ns INTEGER,
                gaze_frequency INTEGER,
                device_serial TEXT,
                app_version TEXT,
                folder_path TEXT NOT NULL,
                scene_video TEXT,
                eye_video TEXT,
                has_gaze_result INTEGER DEFAULT 0,
                imported_at TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS project_recordings (
                project_id TEXT,
                recording_id TEXT,
                PRIMARY KEY (project_id, recording_id),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (recording_id) REFERENCES recordings(id) ON DELETE CASCADE
            )
        """)
        await db.commit()
