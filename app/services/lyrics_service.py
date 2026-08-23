import hashlib
import re
import threading
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher

import httpx
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Music


LRCLIB_URL = "https://lrclib.net/api"
NEGATIVE_CACHE_TTL = timedelta(days=7)
FETCH_LOCK = threading.Lock()
RATE_LIMITED_UNTIL = 0.0


def _clean_title(value: str) -> str:
    value = re.sub(
        r"\s*[\[(][^\])]*(?:official|oficial|lyrics?|letras?|legendado|audio|music\s+video|video|clipe|hd|4k|visualizer|prod(?:uced)?\.?|feat(?:uring)?\.?|ft\.?)[^\])]*[\])]\s*",
        " ",
        value,
        flags=re.I,
    )
    value = re.sub(
        r"\s+(?:official|oficial)?\s*(?:music\s+)?(?:video|clipe|audio|lyrics?|letras?|legendado|visualizer)\s*$",
        "",
        value,
        flags=re.I,
    )
    # Emojis e símbolos decorativos são comuns em títulos do YouTube, mas fazem
    # a busca estruturada do LRCLIB exigir uma correspondência inexistente.
    value = "".join(" " if character != "|" and unicodedata.category(character).startswith("S") else character for character in value)
    return " ".join(value.split()).strip(" -–—!¡|•·.,:;")


def _clean_artist(value: str) -> str:
    value = re.sub(r"(?:vevo|official)$", "", value, flags=re.I)
    value = re.sub(r"\s*[-–—]\s*(?:topic|official|vevo)\s*$", "", value, flags=re.I)
    value = " ".join(value.split()).strip(" -–—")
    letters = value.split()
    if len(letters) >= 4 and all(len(letter) == 1 and letter.isalpha() for letter in letters):
        value = "".join(letters)
    return value


def _normalized(value: str) -> str:
    value = unicodedata.normalize("NFKD", value.casefold())
    value = "".join(character for character in value if not unicodedata.combining(character))
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def _comparison_artist(value: str) -> str:
    primary = re.split(r"\s+(?:feat(?:uring)?\.?|ft\.?)\s+|[/,&]", value, maxsplit=1, flags=re.I)[0]
    return _normalized(_clean_artist(primary))


def _metadata_candidates(music: Music) -> list[tuple[str, str]]:
    title = _clean_title(music.title)
    artist = _clean_artist(music.artist)
    candidates: list[tuple[str, str]] = []

    # YouTube normalmente usa "Artista - Faixa" enquanto o nome do canal pode
    # ser algo automatizado como GunsNRosesVEVO. O prefixo do título é melhor.
    parts = re.split(r"\s+(?:[-–—]|\|)\s+", title, maxsplit=1)
    if len(parts) == 2 and all(part.strip() for part in parts):
        title_artist, track_name = parts
        candidates.append((_clean_title(track_name), _clean_artist(title_artist)))
        # Alguns uploads invertem a convenção e usam "Faixa - Artista".
        candidates.append((_clean_title(title_artist), _clean_artist(track_name)))
    if title and artist:
        candidates.append((title, artist))

    unique: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for track_name, artist_name in candidates:
        key = (_normalized(track_name), _normalized(artist_name))
        if key[0] and key[1] and key not in seen:
            seen.add(key)
            unique.append((track_name, artist_name))
    return unique


def _query_key(music: Music, candidates: list[tuple[str, str]]) -> str:
    raw = repr(("lyrics-match-v8", candidates, music.duration_seconds or 0)).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _retry_after(response: httpx.Response) -> int:
    try:
        return max(1, int(response.headers.get("Retry-After", "30")))
    except ValueError:
        return 30


def _cached_payload(music: Music, query_key: str) -> dict | None:
    if music.synced_lyrics:
        return _serialize(music)
    if music.plain_lyrics and music.lyrics_query_key == query_key:
        return _serialize(music)
    checked = music.lyrics_checked_at
    if checked and music.lyrics_query_key == query_key:
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) - checked < NEGATIVE_CACHE_TTL:
            return _serialize(music)
    return None


def _serialize(music: Music) -> dict:
    has_lyrics = bool(music.synced_lyrics or music.plain_lyrics)
    return {
        "music_id": music.id,
        "provider": "LRCLIB",
        "provider_id": music.lyrics_provider_id,
        "instrumental": bool(music.lyrics_provider_id and not has_lyrics),
        "plain_lyrics": music.plain_lyrics,
        "synced_lyrics": music.synced_lyrics,
    }


def _has_lyrics(item: dict) -> bool:
    return bool(item.get("syncedLyrics") or item.get("plainLyrics"))


def _free_search_queries(track_name: str, artist_name: str) -> list[str]:
    queries = [f"{artist_name} {track_name}"]
    simplified_artist = re.sub(
        r"\s+(?:e|and|&|feat(?:uring)?\.?|ft\.?)\s+",
        " ",
        artist_name,
        flags=re.I,
    )
    simplified_artist = " ".join(simplified_artist.split())
    if _normalized(simplified_artist) != _normalized(artist_name):
        queries.append(f"{simplified_artist} {track_name}")
    return queries


def _pick_search_result(results: list[dict], track_name: str, artist_name: str, duration: int) -> dict | None:
    candidates = [item for item in results if _has_lyrics(item)]
    if not candidates:
        candidates = [item for item in results if item.get("instrumental")]
    if not candidates:
        return None

    wanted_track, wanted_artist = _normalized(_clean_title(track_name)), _comparison_artist(artist_name)

    def similarities(item: dict) -> tuple[float, float, float]:
        track_score = SequenceMatcher(None, wanted_track, _normalized(_clean_title(str(item.get("trackName") or "")))).ratio()
        artist_score = SequenceMatcher(None, wanted_artist, _comparison_artist(str(item.get("artistName") or ""))).ratio()
        duration_difference = abs(float(item.get("duration") or duration or 0) - duration) if duration else 0
        return track_score, artist_score, duration_difference

    synchronized = []
    for item in candidates:
        track_score, artist_score, duration_difference = similarities(item)
        if item.get("syncedLyrics") and track_score >= 0.65 and artist_score >= 0.55 and (not duration or duration_difference <= 25):
            synchronized.append(item)
    if synchronized:
        candidates = synchronized

    def score(item: dict) -> float:
        track_score, artist_score, duration_difference = similarities(item)
        duration_score = max(0.0, 1.0 - duration_difference / 90.0) if duration else 0.5
        synced_bonus = 0.12 if item.get("syncedLyrics") else 0.0
        return track_score * 5 + artist_score * 4 + duration_score * 2 + synced_bonus

    return max(candidates, key=score)


def _rate_limited(response: httpx.Response) -> bool:
    global RATE_LIMITED_UNTIL
    if response.status_code != 429:
        return False
    RATE_LIMITED_UNTIL = time.monotonic() + _retry_after(response)
    return True


def get_or_fetch_lyrics(db: Session, music: Music, refresh: bool = False) -> dict:
    candidates = _metadata_candidates(music)
    query_key = _query_key(music, candidates)
    if not refresh:
        cached = _cached_payload(music, query_key)
        if cached is not None:
            return cached

    headers = {"User-Agent": get_settings().lrclib_user_agent, "Accept": "application/json"}
    if time.monotonic() < RATE_LIMITED_UNTIL:
        return {**_serialize(music), "temporarily_unavailable": True}

    result = None
    duration = music.duration_seconds or 0
    try:
        with FETCH_LOCK, httpx.Client(timeout=8, follow_redirects=True, headers=headers) as client:
            if time.monotonic() < RATE_LIMITED_UNTIL:
                return {**_serialize(music), "temporarily_unavailable": True}

            for track_name, artist_name in candidates:
                params = {"track_name": track_name, "artist_name": artist_name}
                if 1 <= duration <= 3600:
                    params["duration"] = duration
                response = client.get(f"{LRCLIB_URL}/get", params=params)
                if _rate_limited(response):
                    return {**_serialize(music), "temporarily_unavailable": True}
                if response.status_code == 200:
                    candidate = response.json()
                    if _has_lyrics(candidate) or candidate.get("instrumental"):
                        if result is None or candidate.get("syncedLyrics"):
                            result = candidate
                        if candidate.get("syncedLyrics"):
                            break

            if result is None or not result.get("syncedLyrics"):
                for track_name, artist_name in candidates:
                    response = client.get(
                        f"{LRCLIB_URL}/search",
                        params={"track_name": track_name, "artist_name": artist_name},
                    )
                    if _rate_limited(response):
                        return {**_serialize(music), "temporarily_unavailable": True}
                    if response.status_code == 200:
                        search_result = _pick_search_result(response.json(), track_name, artist_name, duration)
                        if search_result is not None and (result is None or search_result.get("syncedLyrics")):
                            result = search_result
                        if result is not None and result.get("syncedLyrics"):
                            break

            # O site do LRCLIB também oferece busca livre. Ela é importante
            # quando os metadados cadastrados possuem créditos ou uma duração
            # diferente da versão do álbum.
            if (result is None or not result.get("syncedLyrics")) and candidates:
                track_name, artist_name = candidates[0]
                for query in _free_search_queries(track_name, artist_name):
                    response = client.get(f"{LRCLIB_URL}/search", params={"q": query})
                    if _rate_limited(response):
                        return {**_serialize(music), "temporarily_unavailable": True}
                    if response.status_code == 200:
                        search_result = _pick_search_result(response.json(), track_name, artist_name, duration)
                        if search_result is not None and (result is None or search_result.get("syncedLyrics")):
                            result = search_result
                        if result is not None and result.get("syncedLyrics"):
                            break
    except (httpx.HTTPError, ValueError, TypeError):
        return {**_serialize(music), "temporarily_unavailable": True}

    music.lyrics_checked_at = datetime.now(timezone.utc)
    music.lyrics_query_key = query_key
    if result:
        music.lyrics_provider_id = result.get("id")
        music.plain_lyrics = result.get("plainLyrics")
        music.synced_lyrics = result.get("syncedLyrics")
    db.commit()
    return _serialize(music)
