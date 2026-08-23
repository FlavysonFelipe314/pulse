from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User
from app.schemas import LoginCreate, RegisterCreate, UserOut, UserPreferences
from app.services.auth_service import (
    SESSION_COOKIE,
    claim_legacy_data,
    clear_session,
    create_session,
    get_current_user,
    hash_password,
    is_first_account,
    normalize_email,
    verify_password,
)


router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=201)
def register(payload: RegisterCreate, request: Request, response: Response, db: Session = Depends(get_db)):
    email = normalize_email(payload.email)
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "Já existe uma conta com este e-mail.")
    first_account = is_first_account(db)
    display_name = " ".join(payload.display_name.split())
    if len(display_name) < 2:
        raise HTTPException(422, "Informe seu nome.")
    user = User(
        email=email,
        display_name=display_name,
        password_hash=hash_password(payload.password),
        auto_download_devices=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    if first_account:
        claim_legacy_data(db, user)
    create_session(db, user, response, request)
    return user


@router.post("/login", response_model=UserOut)
def login(payload: LoginCreate, request: Request, response: Response, db: Session = Depends(get_db)):
    user = db.scalar(select(User).where(User.email == normalize_email(payload.email)))
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "E-mail ou senha incorretos.")
    create_session(db, user, response, request)
    return user


@router.post("/logout", status_code=204)
def logout(
    response: Response,
    token: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    db: Session = Depends(get_db),
):
    clear_session(db, response, token)
    return Response(status_code=204, headers=response.headers)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


@router.patch("/preferences", response_model=UserOut)
def preferences(payload: UserPreferences, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    user.auto_download_devices = payload.auto_download_devices
    db.commit()
    db.refresh(user)
    return user
