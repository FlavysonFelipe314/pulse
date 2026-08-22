"""Legal local-media import boundary.

Imports require an explicit rights confirmation. This service does not bypass
DRM, authentication, paywalls, geo-blocks or other technical restrictions.
"""
import threading
import uuid
from pathlib import Path

from fastapi import HTTPException
import yt_dlp

from app.config import get_settings
from app.database.session import SessionLocal
from app.models import Music


ALLOWED_EXTENSIONS = {".mp3", ".m4a", ".ogg", ".wav", ".flac", ".opus", ".webm"}
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()


class QuietLogger:
    def debug(self, _: str):
        pass

    def warning(self, _: str):
        pass

    def error(self, message: str):
        with JOBS_LOCK:
            self.last_error = message


def job_snapshot(job_id: str) -> dict:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "Importação não encontrada.")
        return dict(job)


def start_youtube_import(music_id: int, video_id: str) -> dict:
    job_id = uuid.uuid4().hex
    with JOBS_LOCK:
        JOBS[job_id] = {"id": job_id, "music_id": music_id, "status": "queued", "progress": 0, "message": "Preparando importação..."}
    thread = threading.Thread(target=_download_worker, args=(job_id, music_id, video_id), daemon=True)
    thread.start()
    return job_snapshot(job_id)


def _update_job(job_id: str, **values) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(values)


def _download_worker(job_id: str, music_id: int, video_id: str) -> None:
    settings = get_settings()
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    output_template = str(settings.storage_dir / f"{token}.%(ext)s")

    def progress_hook(data: dict) -> None:
        if data.get("status") == "downloading":
            total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
            downloaded = data.get("downloaded_bytes") or 0
            percent = min(99, round(downloaded / total * 100)) if total else 5
            _update_job(job_id, status="downloading", progress=percent, message="Baixando áudio autorizado...")
        elif data.get("status") == "finished":
            _update_job(job_id, status="processing", progress=99, message="Preparando arquivo de áudio...")

    options = {
        "format": "bestaudio/best",
        "outtmpl": output_template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "max_filesize": 250 * 1024 * 1024,
        "progress_hooks": [progress_hook],
        "logger": QuietLogger(),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}],
    }
    try:
        _update_job(job_id, status="downloading", progress=1, message="Conectando à fonte...")
        with yt_dlp.YoutubeDL(options) as downloader:
            downloader.download([f"https://www.youtube.com/watch?v={video_id}"])
        target = settings.storage_dir / f"{token}.mp3"
        if not target.is_file():
            candidates = [path for path in settings.storage_dir.glob(f"{token}.*") if path.suffix.lower() in ALLOWED_EXTENSIONS]
            if not candidates:
                raise RuntimeError("O arquivo final não foi criado.")
            target = candidates[0]
        with SessionLocal() as db:
            music = db.get(Music, music_id)
            if not music:
                target.unlink(missing_ok=True)
                raise RuntimeError("A música foi removida durante a importação.")
            music.local_filename = target.name
            db.commit()
        _update_job(job_id, status="complete", progress=100, message="Adicionado à biblioteca")
    except Exception as exc:
        for partial in settings.storage_dir.glob(f"{token}.*"):
            partial.unlink(missing_ok=True)
        message = str(exc)
        if "ffmpeg" in message.lower():
            message = "FFmpeg não foi encontrado. Instale-o e tente novamente."
        elif len(message) > 240:
            message = "A fonte recusou ou não disponibilizou este conteúdo para importação."
        _update_job(job_id, status="failed", progress=0, message=message)


def resolve_media_file(filename: str) -> Path:
    if Path(filename).name != filename or Path(filename).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "Arquivo de mídia inválido.")
    storage = get_settings().storage_dir.resolve()
    target = (storage / filename).resolve()
    if storage not in target.parents or not target.is_file():
        raise HTTPException(404, "Arquivo de mídia não encontrado.")
    return target


def delete_media_file(filename: str | None) -> None:
    if not filename:
        return
    try:
        resolve_media_file(filename).unlink(missing_ok=True)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
