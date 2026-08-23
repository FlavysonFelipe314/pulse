import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import Cookie, Depends, HTTPException, Request, Response, status
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Folder, Music, PlaybackHistory, Playlist, User, UserMusic, UserSession


SESSION_COOKIE = "pulse_session"
SESSION_DAYS = 30
SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if "@" not in email or email.startswith("@") or email.endswith("@"):
        raise HTTPException(422, "Informe um e-mail válido.")
    return email


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=32)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt_hex, digest_hex = encoded.split("$", 5)
        if algorithm != "scrypt":
            return False
        candidate = hashlib.scrypt(
            password.encode("utf-8"), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r), p=int(p), dklen=32
        )
        return hmac.compare_digest(candidate, bytes.fromhex(digest_hex))
    except (ValueError, TypeError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(db: Session, user: User, response: Response, request: Request) -> None:
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
    db.add(UserSession(user_id=user.id, token_hash=_token_hash(token), expires_at=expires))
    db.commit()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 24 * 60 * 60,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="lax",
        path="/",
    )


def clear_session(db: Session, response: Response, token: str | None) -> None:
    if token:
        session = db.scalar(select(UserSession).where(UserSession.token_hash == _token_hash(token)))
        if session:
            db.delete(session)
            db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/", samesite="lax")


def get_current_user(
    token: str | None = Cookie(default=None, alias=SESSION_COOKIE), db: Session = Depends(get_db)
) -> User:
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Entre na sua conta para continuar.")
    user = user_from_session_token(db, token)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sua sessão expirou. Entre novamente.")
    return user


def user_from_session_token(db: Session, token: str | None) -> User | None:
    if not token:
        return None
    user = db.scalar(
        select(User)
        .join(UserSession, UserSession.user_id == User.id)
        .where(UserSession.token_hash == _token_hash(token), UserSession.expires_at > datetime.now(timezone.utc))
    )
    return user


def claim_legacy_data(db: Session, user: User) -> None:
    for music in db.scalars(select(Music)).all():
        if not db.get(UserMusic, (user.id, music.id)):
            db.add(UserMusic(user_id=user.id, music_id=music.id, favorite=music.favorite, added_at=music.added_at))
    db.execute(update(Playlist).where(Playlist.user_id.is_(None)).values(user_id=user.id))
    db.execute(update(Folder).where(Folder.user_id.is_(None)).values(user_id=user.id))
    db.execute(update(PlaybackHistory).where(PlaybackHistory.user_id.is_(None)).values(user_id=user.id))
    db.commit()


def is_first_account(db: Session) -> bool:
    return (db.scalar(select(func.count(User.id))) or 0) == 0
