from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.models import Folder, Playlist, PlaylistMusic, User
from app.schemas import FolderCreate, FolderOut, PlaylistCreate, PlaylistOut
from app.services.library_service import get_music_or_404, playlist_or_404, serialize_playlist
from app.services.auth_service import get_current_user


router = APIRouter(tags=["collections"])


@router.get("/playlists", response_model=list[PlaylistOut])
def list_playlists(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    playlists = db.scalars(select(Playlist).options(selectinload(Playlist.music_links).selectinload(PlaylistMusic.music)).where(Playlist.user_id == user.id).order_by(Playlist.created_at.desc())).all()
    return [serialize_playlist(db, item, user.id) for item in playlists]


@router.post("/playlists", response_model=PlaylistOut, status_code=201)
def create_playlist(payload: PlaylistCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if payload.folder_id and not db.scalar(select(Folder).where(Folder.id == payload.folder_id, Folder.user_id == user.id)):
        raise HTTPException(404, "Pasta não encontrada.")
    playlist = Playlist(user_id=user.id, **payload.model_dump())
    db.add(playlist)
    db.commit()
    return serialize_playlist(db, playlist, user.id)


@router.delete("/playlists/{playlist_id}", status_code=204)
def delete_playlist(playlist_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    playlist = playlist_or_404(db, playlist_id, user.id)
    db.delete(playlist)
    db.commit()
    return Response(status_code=204)


@router.patch("/playlists/{playlist_id}/visibility", response_model=PlaylistOut)
def toggle_visibility(playlist_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    playlist = playlist_or_404(db, playlist_id, user.id)
    playlist.is_public = not playlist.is_public
    db.commit()
    db.refresh(playlist)
    return serialize_playlist(db, playlist_or_404(db, playlist_id, user.id), user.id)


@router.post("/playlists/{playlist_id}/tracks/{music_id}", response_model=PlaylistOut)
def add_track(playlist_id: int, music_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    playlist = playlist_or_404(db, playlist_id, user.id)
    get_music_or_404(db, music_id, user.id)
    if any(link.music_id == music_id for link in playlist.music_links):
        return serialize_playlist(db, playlist, user.id)
    next_position = max((link.position for link in playlist.music_links), default=-1) + 1
    db.add(PlaylistMusic(playlist_id=playlist_id, music_id=music_id, position=next_position))
    db.commit()
    db.expire_all()
    return serialize_playlist(db, playlist_or_404(db, playlist_id, user.id), user.id)


@router.delete("/playlists/{playlist_id}/tracks/{music_id}", response_model=PlaylistOut)
def remove_track(playlist_id: int, music_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    playlist_or_404(db, playlist_id, user.id)
    link = db.get(PlaylistMusic, (playlist_id, music_id))
    if not link:
        raise HTTPException(404, "Música não está na playlist.")
    db.delete(link)
    db.commit()
    return serialize_playlist(db, playlist_or_404(db, playlist_id, user.id), user.id)


@router.put("/playlists/{playlist_id}/reorder", response_model=PlaylistOut)
def reorder(playlist_id: int, music_ids: list[int], user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    playlist = playlist_or_404(db, playlist_id, user.id)
    existing = {link.music_id for link in playlist.music_links}
    if set(music_ids) != existing or len(music_ids) != len(existing):
        raise HTTPException(400, "A ordem deve conter exatamente as músicas da playlist.")
    positions = {music_id: index for index, music_id in enumerate(music_ids)}
    for link in playlist.music_links:
        link.position = positions[link.music_id]
    db.commit()
    db.expire_all()
    return serialize_playlist(db, playlist_or_404(db, playlist_id, user.id), user.id)


@router.get("/folders", response_model=list[FolderOut])
def list_folders(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.scalars(select(Folder).where(Folder.user_id == user.id).order_by(Folder.name)).all()


@router.post("/folders", response_model=FolderOut, status_code=201)
def create_folder(payload: FolderCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if payload.parent_id and not db.scalar(select(Folder).where(Folder.id == payload.parent_id, Folder.user_id == user.id)):
        raise HTTPException(404, "Pasta superior não encontrada.")
    folder = Folder(user_id=user.id, **payload.model_dump())
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return folder
