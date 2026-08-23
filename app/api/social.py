from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.models import Friendship, Playlist, PlaylistMusic, User
from app.schemas import PublicUserOut
from app.services.auth_service import get_current_user
from app.services.library_service import serialize_playlist


router = APIRouter(prefix="/social", tags=["social"])


def friendship_key(first_id: int, second_id: int) -> tuple[int, int]:
    return (min(first_id, second_id), max(first_id, second_id))


def friendship_status(db: Session, user_id: int, other_id: int) -> str | None:
    friendship = db.get(Friendship, friendship_key(user_id, other_id))
    if not friendship:
        return None
    if friendship.status == "accepted":
        return "friends"
    return "outgoing" if friendship.requested_by_id == user_id else "incoming"


def public_user(db: Session, viewer_id: int, user: User) -> dict:
    return {"id": user.id, "display_name": user.display_name, "friendship_status": friendship_status(db, viewer_id, user.id)}


@router.get("/users", response_model=list[PublicUserOut])
def search_users(
    q: str = Query(min_length=2, max_length=100),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = " ".join(q.split())
    users = db.scalars(select(User).where(User.id != user.id, User.display_name.ilike(f"%{query}%")).order_by(User.display_name).limit(20)).all()
    return [public_user(db, user.id, item) for item in users]


@router.get("/users/{user_id}/playlists")
def public_playlists(user_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    owner = db.get(User, user_id)
    if not owner:
        raise HTTPException(404, "Perfil não encontrado.")
    playlists = db.scalars(
        select(Playlist)
        .options(selectinload(Playlist.music_links).selectinload(PlaylistMusic.music))
        .where(Playlist.user_id == user_id, Playlist.is_public.is_(True))
        .order_by(Playlist.created_at.desc())
    ).all()
    result = []
    for playlist in playlists:
        serialized = serialize_playlist(db, playlist, user_id)
        for track in serialized["tracks"]:
            track["favorite"] = False
        result.append(serialized)
    return {"user": public_user(db, user.id, owner), "playlists": result}


@router.get("/friends", response_model=list[PublicUserOut])
def list_friends(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    friendships = db.scalars(select(Friendship).where(Friendship.status == "accepted", or_(Friendship.user_low_id == user.id, Friendship.user_high_id == user.id))).all()
    ids = [item.user_high_id if item.user_low_id == user.id else item.user_low_id for item in friendships]
    users = db.scalars(select(User).where(User.id.in_(ids)).order_by(User.display_name)).all() if ids else []
    return [public_user(db, user.id, item) for item in users]


@router.get("/friends/requests", response_model=list[PublicUserOut])
def friend_requests(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    friendships = db.scalars(
        select(Friendship).where(
            Friendship.status == "pending",
            or_(Friendship.user_low_id == user.id, Friendship.user_high_id == user.id),
            Friendship.requested_by_id != user.id,
        )
    ).all()
    ids = [item.requested_by_id for item in friendships]
    users = db.scalars(select(User).where(User.id.in_(ids)).order_by(User.display_name)).all() if ids else []
    return [public_user(db, user.id, item) for item in users]


@router.post("/friends/{other_id}", status_code=201)
def request_friend(other_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if other_id == user.id or not db.get(User, other_id):
        raise HTTPException(404, "Perfil não encontrado.")
    key = friendship_key(user.id, other_id)
    existing = db.get(Friendship, key)
    if existing:
        if existing.status == "accepted":
            return {"status": "friends"}
        if existing.requested_by_id != user.id:
            raise HTTPException(409, "Esta pessoa já enviou um convite para você.")
        return {"status": "outgoing"}
    db.add(Friendship(user_low_id=key[0], user_high_id=key[1], requested_by_id=user.id, status="pending"))
    db.commit()
    return {"status": "outgoing"}


@router.post("/friends/{other_id}/accept")
def accept_friend(other_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    friendship = db.get(Friendship, friendship_key(user.id, other_id))
    if not friendship or friendship.status != "pending" or friendship.requested_by_id == user.id:
        raise HTTPException(404, "Convite não encontrado.")
    friendship.status = "accepted"
    friendship.accepted_at = datetime.now(timezone.utc)
    db.commit()
    return {"status": "friends"}


@router.delete("/friends/{other_id}", status_code=204)
def remove_friend(other_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    friendship = db.get(Friendship, friendship_key(user.id, other_id))
    if friendship:
        db.delete(friendship)
        db.commit()
    return Response(status_code=204)


def are_friends(db: Session, first_id: int, second_id: int) -> bool:
    friendship = db.get(Friendship, friendship_key(first_id, second_id))
    return bool(friendship and friendship.status == "accepted")
