from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from app.database import init_db
from app.api.routes import recordings, projects, gaze, events, aoi


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="PupilLabsReplacer API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:1420", "http://localhost:5173", "tauri://localhost"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(recordings.router)
app.include_router(projects.router)
app.include_router(gaze.router)
app.include_router(events.router)
app.include_router(aoi.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "version": "0.1.0"}
