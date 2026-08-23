"""Legal local-media import boundary.

This service is intended only for media the user is authorized to import. It
does not bypass DRM, authentication, paywalls or other technical restrictions.
"""
import subprocess
import threading
import time
import uuid
import logging
import re
import sys
from collections.abc import Iterator
from pathlib import Path

from fastapi import HTTPException
import yt_dlp

from app.config import get_settings
from app.database.session import SessionLocal
from app.models import Music


ALLOWED_EXTENSIONS = {".mp3", ".m4a", ".ogg", ".wav", ".flac", ".opus", ".webm"}
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
logger = logging.getLogger(__name__)


def _safe_log_message(exc: Exception) -> str:
    # FFmpeg can include the complete signed media URL in its error output.
    # Keep diagnostics useful without leaking temporary URLs or query tokens.
    return re.sub(r"https?://\S+", "[URL removida]", str(exc))[:2000]


class QuietLogger:
    def __init__(self):
        self.last_error = ""

    def debug(self, _: str):
        pass

    def warning(self, _: str):
        pass

    def error(self, message: str):
        self.last_error = message


def _yt_dlp_options(settings) -> dict:
    options = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "logger": QuietLogger(),
    }
    if settings.youtube_cookies_file:
        cookie_file = settings.youtube_cookies_file.expanduser().resolve()
        if not cookie_file.is_file():
            raise RuntimeError("O arquivo de cookies configurado no servidor não foi encontrado.")
        options["cookiefile"] = str(cookie_file)
    clients = [client.strip() for client in settings.youtube_player_clients.split(",") if client.strip()]
    if clients:
        options["extractor_args"] = {"youtube": {"player_client": clients}}
    return options


def _yt_dlp_pipe_command(options: dict, video_id: str) -> list[str]:
    """Let yt-dlp keep authenticated media requests under its own control."""
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--quiet",
        "--no-warnings",
        "--no-playlist",
        "--format",
        "bestaudio/best",
        "--output",
        "-",
    ]
    if options.get("cookiefile"):
        command.extend(["--cookies", options["cookiefile"]])
    clients = options.get("extractor_args", {}).get("youtube", {}).get("player_client", [])
    if clients:
        command.extend(["--extractor-args", f"youtube:player_client={','.join(clients)}"])
    command.extend(["--", f"https://www.youtube.com/watch?v={video_id}"])
    return command


def _public_import_error(exc: Exception) -> str:
    message = str(exc)
    lowered = message.lower()
    if isinstance(exc, FileNotFoundError):
        return "FFmpeg não foi encontrado no servidor. Instale-o e reinicie o serviço."
    if "arquivo de cookies" in lowered:
        return message
    if "sign in to confirm" in lowered or "not a bot" in lowered:
        return "O YouTube bloqueou o IP do servidor. Configure cookies válidos no deploy e tente novamente."
    if "javascript runtime" in lowered or "js runtime" in lowered:
        return "O servidor precisa de um runtime JavaScript compatível (Deno) para importar do YouTube."
    if "ffmpeg" in lowered and ("not found" in lowered or "no such file" in lowered):
        return "FFmpeg não foi encontrado no servidor. Instale-o e reinicie o serviço."
    return "A fonte recusou ou não disponibilizou este conteúdo para importação."


def job_snapshot(job_id: str, user_id: int | None = None) -> dict:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "Importação não encontrada.")
        if user_id is not None and user_id not in job.get("_user_ids", set()):
            raise HTTPException(404, "Importação não encontrada.")
        return {key: value for key, value in job.items() if not key.startswith("_")}


def stream_job(job_id: str, user_id: int | None = None) -> Iterator[bytes]:
    position = 0
    handle = None
    try:
        while True:
            with JOBS_LOCK:
                job = JOBS.get(job_id)
                if not job:
                    return
                if user_id is not None and user_id not in job.get("_user_ids", set()):
                    return
                path_value = job.get("_path")
                status = job["status"]
            if handle is None and path_value:
                path = Path(path_value)
                if path.is_file():
                    handle = path.open("rb")
            if handle:
                handle.seek(position)
                chunk = handle.read(64 * 1024)
                if chunk:
                    position += len(chunk)
                    yield chunk
                    continue
            if status in {"complete", "failed"}:
                return
            time.sleep(0.12)
    finally:
        if handle:
            handle.close()


def job_id_for_music(music_id: int) -> str | None:
    """Return the newest usable progressive job for a music record."""
    with JOBS_LOCK:
        matches = [
            job for job in JOBS.values()
            if job.get("music_id") == music_id and job.get("status") != "failed"
        ]
        return matches[-1]["id"] if matches else None


def start_youtube_import(music_id: int, video_id: str, user_id: int) -> dict:
    with JOBS_LOCK:
        for existing in JOBS.values():
            if existing["music_id"] == music_id and existing["status"] not in {"complete", "failed"}:
                existing.setdefault("_user_ids", set()).add(user_id)
                return {key: value for key, value in existing.items() if not key.startswith("_")}
        job_id = uuid.uuid4().hex
        JOBS[job_id] = {"id": job_id, "music_id": music_id, "status": "queued", "progress": 0, "message": "Preparando importação...", "_user_ids": {user_id}}
    thread = threading.Thread(target=_download_worker, args=(job_id, music_id, video_id), daemon=True)
    thread.start()
    return job_snapshot(job_id, user_id)


def _update_job(job_id: str, **values) -> None:
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(values)


def _download_worker(job_id: str, music_id: int, video_id: str) -> None:
    settings = get_settings()
    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    target = settings.storage_dir / f"{token}.mp3"
    downloader_process = None
    ffmpeg_process = None
    try:
        options = _yt_dlp_options(settings)
        _update_job(job_id, status="extracting", progress=1, message="Preparando transmissão...")
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        duration = int(info.get("duration") or 0)
        if duration > 4 * 60 * 60:
            raise RuntimeError("O conteúdo excede o limite de quatro horas.")
        expected_bytes = max(1, duration * 192_000 // 8) if duration else 0
        creation_flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0
        downloader_process = subprocess.Popen(
            _yt_dlp_pipe_command(options, video_id),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creation_flags,
        )
        ffmpeg_command = [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
            "-i", "pipe:0", "-vn", "-map_metadata", "-1",
            "-codec:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", "pipe:1",
        ]
        ffmpeg_process = subprocess.Popen(
            ffmpeg_command,
            stdin=downloader_process.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creation_flags,
        )
        if downloader_process.stdout:
            downloader_process.stdout.close()
        written = 0
        _update_job(job_id, status="streaming", progress=2, message="Reproduzindo enquanto baixa...", _path=str(target))
        with target.open("wb") as output:
            while True:
                chunk = ffmpeg_process.stdout.read(64 * 1024) if ffmpeg_process.stdout else b""
                if not chunk:
                    break
                output.write(chunk)
                output.flush()
                written += len(chunk)
                percent = min(99, round(written / expected_bytes * 100)) if expected_bytes else 10
                _update_job(job_id, status="streaming", progress=percent, message="Reproduzindo enquanto baixa...")
        ffmpeg_stderr = ffmpeg_process.stderr.read().decode("utf-8", errors="replace") if ffmpeg_process.stderr else ""
        ffmpeg_return_code = ffmpeg_process.wait()
        downloader_stderr = downloader_process.stderr.read().decode("utf-8", errors="replace") if downloader_process.stderr else ""
        downloader_return_code = downloader_process.wait()
        if downloader_return_code != 0 or ffmpeg_return_code != 0 or written < 1024:
            raise RuntimeError(
                downloader_stderr.strip()
                or ffmpeg_stderr.strip()
                or "A transmissão de áudio foi interrompida."
            )
        with SessionLocal() as db:
            music = db.get(Music, music_id)
            if not music:
                target.unlink(missing_ok=True)
                raise RuntimeError("A música foi removida durante a importação.")
            music.local_filename = target.name
            db.commit()
        _update_job(job_id, status="complete", progress=100, message="Adicionado à biblioteca")
    except Exception as exc:
        for child in (ffmpeg_process, downloader_process):
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
        try:
            target.unlink(missing_ok=True)
        except PermissionError:
            pass
        logger.error(
            "Falha na importação do YouTube job=%s music_id=%s video_id=%s: %s",
            job_id,
            music_id,
            video_id,
            _safe_log_message(exc),
        )
        _update_job(job_id, status="failed", progress=0, message=_public_import_error(exc))


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
