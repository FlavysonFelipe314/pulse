from fastapi import APIRouter, Depends, Query

from app.services.youtube_service import search_youtube
from app.models import User
from app.services.auth_service import get_current_user


router = APIRouter(prefix="/youtube", tags=["youtube"])


@router.get("/search")
async def search(q: str = Query(min_length=2, max_length=120), limit: int = Query(default=12, ge=1, le=25), _: User = Depends(get_current_user)):
    return {"items": await search_youtube(" ".join(q.split()), limit)}
