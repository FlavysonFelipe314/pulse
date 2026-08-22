from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.models import Folder, Playlist, PlaylistMusic
from app.schemas import FolderCreate, FolderOut, PlaylistCreate, PlaylistOut
from app.services.library_service import get_music_or_404, playlist_or_404, serialize_playlist


router = APIRouter(tags=["collections"])


@router.get("/playlists", response_model=list[PlaylistOut])
def list_playlists(db: Session = Depends(get_db)):
    playlists = db.scalars(select(Playlist).options(selectinload(Playlist.music_links).selectinload(PlaylistMusic.music)).order_by(Playlist.created_at.desc())).all()
    return [serialize_playlist(item) for item in playlists]


@router.post("/playlists", response_model=PlaylistOut, status_code=201)
def create_playlist(payload: PlaylistCreate, db: Session = Depends(get_db)):
    if payload.folder_id and not db.get(Folder, payload.folder_id):
        raise HTTPException(404, "Pasta não encontrada.")
    playlist = Playlist(**payload.model_dump())
    db.add(playlist)
    db.commit()
    return serialize_playlist(playlist)


@router.delete("/playlists/{playlist_id}", status_code=204)
def delete_playlist(playlist_id: int, db: Session = Depends(get_db)):
    playlist = playlist_or_404(db, playlist_id)
    db.delete(playlist)
    db.commit()
    return Response(status_code=204)


@router.post("/playlists/{playlist_id}/tracks/{music_id}", response_model=PlaylistOut)
def add_track(playlist_id: int, music_id: int, db: Session = Depends(get_db)):
    playlist = playlist_or_404(db, playlist_id)
    get_music_or_404(db, music_id)
    if any(link.music_id == music_id for link in playlist.music_links):
        return serialize_playlist(playlist)
    next_position = max((link.position for link in playlist.music_links), default=-1) + 1
    db.add(PlaylistMusic(playlist_id=playlist_id, music_id=music_id, position=next_position))
    db.commit()
    db.expire_all()
    return serialize_playlist(playlist_or_404(db, playlist_id))


@router.delete("/playlists/{playlist_id}/tracks/{music_id}", response_model=PlaylistOut)
def remove_track(playlist_id: int, music_id: int, db: Session = Depends(get_db)):
    link = db.get(PlaylistMusic, (playlist_id, music_id))
    if not link:
        raise HTTPException(404, "Música não está na playlist.")
    db.delete(link)
    db.commit()
    return serialize_playlist(playlist_or_404(db, playlist_id))


@router.put("/playlists/{playlist_id}/reorder", response_model=PlaylistOut)
def reorder(playlist_id: int, music_ids: list[int], db: Session = Depends(get_db)):
    playlist = playlist_or_404(db, playlist_id)
    existing = {link.music_id for link in playlist.music_links}
    if set(music_ids) != existing or len(music_ids) != len(existing):
        raise HTTPException(400, "A ordem deve conter exatamente as músicas da playlist.")
    positions = {music_id: index for index, music_id in enumerate(music_ids)}
    for link in playlist.music_links:
        link.position = positions[link.music_id]
    db.commit()
    db.expire_all()
    return serialize_playlist(playlist_or_404(db, playlist_id))


@router.get("/folders", response_model=list[FolderOut])
def list_folders(db: Session = Depends(get_db)):
    return db.scalars(select(Folder).order_by(Folder.name)).all()


@router.post("/folders", response_model=FolderOut, status_code=201)
def create_folder(payload: FolderCreate, db: Session = Depends(get_db)):
    if payload.parent_id and not db.get(Folder, payload.parent_id):
        raise HTTPException(404, "Pasta superior não encontrada.")
    folder = Folder(**payload.model_dump())
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return folder
