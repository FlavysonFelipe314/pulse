from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.schemas import DownloadCreate
from app.services.library_service import add_music
from app.services.media_service import job_snapshot, start_youtube_import


router = APIRouter(prefix="/downloads", tags=["downloads"])


@router.post("", status_code=202)
def create_download(payload: DownloadCreate, db: Session = Depends(get_db)):
    if not payload.rights_confirmed:
        raise HTTPException(400, "Confirme que você possui autorização para importar este conteúdo.")
    if not payload.track.youtube_video_id:
        raise HTTPException(400, "O vídeo informado é inválido.")
    music = add_music(db, payload.track)
    if music.local_filename:
        return {"id": None, "music_id": music.id, "status": "complete", "progress": 100, "message": "Já está na biblioteca"}
    return start_youtube_import(music.id, payload.track.youtube_video_id)


@router.get("/{job_id}")
def get_download(job_id: str):
    return job_snapshot(job_id)
