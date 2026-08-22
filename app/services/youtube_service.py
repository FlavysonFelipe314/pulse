import re

import httpx
from fastapi import HTTPException, status

from app.config import get_settings


YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"


def iso_duration_seconds(value: str) -> int:
    match = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", value or "")
    if not match:
        return 0
    hours, minutes, seconds = (int(part or 0) for part in match.groups())
    return hours * 3600 + minutes * 60 + seconds


async def search_youtube(query: str, limit: int = 12) -> list[dict]:
    api_key = get_settings().youtube_api_key
    if not api_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Configure YOUTUBE_API_KEY no arquivo .env para pesquisar no YouTube.",
        )
    params = {
        "part": "snippet",
        "type": "video",
        "videoCategoryId": "10",
        "maxResults": limit,
        "q": query,
        "key": api_key,
    }
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            search_response = await client.get(YOUTUBE_SEARCH_URL, params=params)
            search_response.raise_for_status()
            raw_items = search_response.json().get("items", [])
            items = [
                item
                for item in raw_items
                if isinstance(item, dict)
                and isinstance(item.get("id"), dict)
                and item["id"].get("videoId")
                and isinstance(item.get("snippet"), dict)
            ]
            ids = [item["id"]["videoId"] for item in items]
            durations: dict[str, int] = {}
            if ids:
                detail_response = await client.get(
                    YOUTUBE_VIDEOS_URL,
                    params={"part": "contentDetails", "id": ",".join(ids), "key": api_key},
                )
                detail_response.raise_for_status()
                durations = {
                    item["id"]: iso_duration_seconds(item["contentDetails"]["duration"])
                    for item in detail_response.json().get("items", [])
                }
    except httpx.HTTPStatusError as exc:
        message = "A pesquisa do YouTube não está disponível agora."
        if exc.response.status_code in {400, 403}:
            message = "A chave do YouTube é inválida ou excedeu a cota."
        raise HTTPException(status_code=502, detail=message) from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail="Não foi possível conectar ao YouTube.") from exc

    results = []
    for item in items:
        video_id = item["id"]["videoId"]
        snippet = item["snippet"]
        thumbnails = snippet.get("thumbnails", {})
        thumbnail = (thumbnails.get("high") or thumbnails.get("medium") or thumbnails.get("default") or {}).get("url")
        results.append(
            {
                "videoId": video_id,
                "title": snippet.get("title", "Sem título"),
                "channel": snippet.get("channelTitle", "Canal desconhecido"),
                "thumbnail": thumbnail,
                "durationSeconds": durations.get(video_id),
                "youtubeUrl": f"https://www.youtube.com/watch?v={video_id}",
            }
        )
    return results
