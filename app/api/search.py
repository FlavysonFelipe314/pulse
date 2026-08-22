from fastapi import APIRouter, Query

from app.services.youtube_service import search_youtube


router = APIRouter(prefix="/youtube", tags=["youtube"])


@router.get("/search")
async def search(q: str = Query(min_length=2, max_length=120), limit: int = Query(default=12, ge=1, le=25)):
    return {"items": await search_youtube(" ".join(q.split()), limit)}

