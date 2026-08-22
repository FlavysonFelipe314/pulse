from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.api import downloads, library, player, playlists, search
from app.config import BASE_DIR, get_settings
from app.database.session import Base, engine
from app.services.media_service import resolve_media_file


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(engine)
    yield


settings = get_settings()
app = FastAPI(title=settings.app_name, debug=settings.debug_mode, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")

app.include_router(search.router, prefix="/api")
app.include_router(library.router, prefix="/api")
app.include_router(playlists.router, prefix="/api")
app.include_router(player.router, prefix="/api")
app.include_router(downloads.router, prefix="/api")


@app.get("/", include_in_schema=False)
def home(request: Request):
    return templates.TemplateResponse(request, "index.html", {"app_name": settings.app_name})


@app.get("/api/media/music/{music_id}", include_in_schema=False)
def stream_media(music_id: int):
    from app.database.session import SessionLocal
    from app.models import Music

    with SessionLocal() as db:
        music = db.get(Music, music_id)
        if not music or not music.local_filename:
            from fastapi import HTTPException
            raise HTTPException(404, "Arquivo de mídia não encontrado.")
        path = resolve_media_file(music.local_filename)
    return FileResponse(path)


@app.get("/api/health")
def health():
    return {"status": "ok"}
