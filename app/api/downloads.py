from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas import DownloadCreate
from app.services.library_service import add_music
from app.services.media_service import job_snapshot, start_youtube_import, stream_job
from app.models import User
from app.services.auth_service import get_current_user


router = APIRouter(prefix="/downloads", tags=["downloads"])


@router.post("", status_code=202)
def create_download(payload: DownloadCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not payload.track.youtube_video_id:
        raise HTTPException(400, "O vídeo informado é inválido.")
    music = add_music(db, payload.track, user.id)
    if music.local_filename:
        return {"id": None, "music_id": music.id, "status": "complete", "progress": 100, "message": "Já está na biblioteca"}
    return start_youtube_import(music.id, payload.track.youtube_video_id, user.id)


@router.get("/{job_id}")
def get_download(job_id: str, user: User = Depends(get_current_user)):
    return job_snapshot(job_id, user.id)


@router.get("/{job_id}/stream", include_in_schema=False)
def stream_download(job_id: str, user: User = Depends(get_current_user)):
    job_snapshot(job_id, user.id)
    return StreamingResponse(stream_job(job_id, user.id), media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
