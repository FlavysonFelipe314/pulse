import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.database.session import SessionLocal
from app.models import Music, User, UserMusic
from app.schemas import MusicCreate, RoomCreate
from app.services.auth_service import SESSION_COOKIE, get_current_user, user_from_session_token
from app.services.library_service import add_music, serialize_music
from app.services.media_service import job_id_for_music, resolve_media_file, start_youtube_import, stream_job
from app.services.room_service import (
    add_room_member,
    broadcast_room,
    can_access_room_media,
    connect_room,
    create_room,
    disconnect_room,
    get_room,
    queue_entry,
    update_playback,
)
from app.api.social import are_friends


api_router = APIRouter(prefix="/rooms", tags=["rooms"])
ws_router = APIRouter(tags=["rooms"])


@api_router.post("")
async def create(payload: RoomCreate, user: User = Depends(get_current_user)):
    name = " ".join(payload.name.split())
    if len(name) < 2:
        raise HTTPException(422, "Informe um nome para a sala.")
    room = await create_room(user.id, user.display_name, name, payload.queue_policy)
    return room.snapshot()


@api_router.post("/{code}/join")
def join(code: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    room = get_room(code)
    if not room:
        raise HTTPException(404, "Sala não encontrada ou encerrada.")
    if user.id != room.owner_id and not are_friends(db, user.id, room.owner_id):
        raise HTTPException(403, "Somente amigos do anfitrião podem entrar nesta sala.")
    add_room_member(room, user.id, user.display_name)
    return room.snapshot()


@api_router.get("/{code}")
def room_state(code: str, user: User = Depends(get_current_user)):
    room = get_room(code)
    if not room or user.id not in room.members:
        raise HTTPException(404, "Sala não encontrada.")
    return room.snapshot()


@api_router.get("/{code}/media/{music_id}", include_in_schema=False)
def room_media(code: str, music_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not can_access_room_media(code, user.id, music_id):
        raise HTTPException(404, "Mídia não disponível nesta sala.")
    music = db.get(Music, music_id)
    if not music:
        raise HTTPException(404, "Arquivo de mídia não encontrado.")
    if music.local_filename:
        return FileResponse(resolve_media_file(music.local_filename))
    job_id = job_id_for_music(music_id)
    if not job_id:
        raise HTTPException(404, "O download desta música ainda não foi iniciado.")
    return StreamingResponse(
        stream_job(job_id),
        media_type="audio/mpeg",
        headers={"Cache-Control": "no-store", "X-Pulse-Stream": "progressive"},
    )


@ws_router.websocket("/ws/rooms/{code}")
async def room_socket(websocket: WebSocket, code: str):
    token = websocket.cookies.get(SESSION_COOKIE)
    with SessionLocal() as db:
        user = user_from_session_token(db, token)
        room = get_room(code)
        if not user or not room or user.id not in room.members:
            await websocket.close(code=4403)
            return
        user_id, display_name = user.id, user.display_name
    await connect_room(room, user_id, websocket)
    try:
        while True:
            data = await websocket.receive_json()
            message_type = data.get("type")
            if message_type == "chat":
                text = " ".join(str(data.get("text", "")).split())[:500]
                if text:
                    message = {"type": "chat", "id": uuid.uuid4().hex, "user": {"id": user_id, "display_name": display_name}, "text": text, "created_at": time.time()}
                    room.messages.append(message)
                    room.messages = room.messages[-50:]
                    await broadcast_room(room, message)
            elif message_type in {"queue_add", "queue_add_track"}:
                is_owner = user_id == room.owner_id
                if not is_owner and room.queue_policy == "host_only":
                    await websocket.send_json({"type": "room_error", "message": "Somente o anfitrião pode adicionar músicas nesta sala."})
                    continue
                with SessionLocal() as db:
                    if message_type == "queue_add_track":
                        try:
                            payload = MusicCreate.model_validate(data.get("track") or {})
                        except ValueError:
                            await websocket.send_json({"type": "room_error", "message": "Música inválida."})
                            continue
                        music = add_music(db, payload, user_id)
                        music_id = music.id
                    else:
                        music_id = int(data.get("music_id") or 0)
                        music = db.get(Music, music_id)
                    link = db.get(UserMusic, (user_id, music_id))
                    if music and link and (music.local_filename or music.youtube_video_id):
                        entry = queue_entry(serialize_music(music, link), user_id, display_name)
                        if not is_owner and room.queue_policy == "approval":
                            duplicate = any(
                                item["music"]["id"] == music.id and item["added_by"]["id"] == user_id
                                for item in room.pending_requests
                            )
                            if duplicate:
                                await websocket.send_json({"type": "room_error", "message": "Essa música já está aguardando aprovação."})
                                continue
                            room.pending_requests.append(entry)
                        else:
                            if not music.local_filename and music.youtube_video_id:
                                start_youtube_import(music.id, music.youtube_video_id, user_id)
                            room.queue.append(entry)
                        await broadcast_room(room)
                    else:
                        await websocket.send_json({"type": "room_error", "message": "Não foi possível adicionar esta música."})
            elif message_type in {"queue_request_accept", "queue_request_reject"} and user_id == room.owner_id:
                request_id = str(data.get("request_id", ""))
                index = next((i for i, item in enumerate(room.pending_requests) if item["id"] == request_id), -1)
                if index >= 0:
                    entry = room.pending_requests.pop(index)
                    accepted = message_type == "queue_request_accept"
                    if message_type == "queue_request_accept":
                        room.queue.append(entry)
                        music_data = entry.get("music", {})
                        with SessionLocal() as db:
                            music = db.get(Music, int(music_data.get("id") or 0))
                            if music and not music.local_filename and music.youtube_video_id:
                                start_youtube_import(music.id, music.youtube_video_id, int(entry["added_by"]["id"]))
                    await broadcast_room(room)
                    notice = "Seu pedido foi aceito e entrou na fila." if accepted else "O host recusou seu pedido de música."
                    for member_socket in list(room.connections.get(int(entry["added_by"]["id"]), set())):
                        await member_socket.send_json({"type": "room_notice", "message": notice})
            elif message_type == "queue_remove":
                entry_id = str(data.get("entry_id", ""))
                entry = next((item for item in room.queue if item["id"] == entry_id), None)
                if entry and (user_id == room.owner_id or entry["added_by"]["id"] == user_id):
                    room.queue = [item for item in room.queue if item["id"] != entry_id]
                    await broadcast_room(room)
            elif message_type == "queue_move" and user_id == room.owner_id:
                entry_id = str(data.get("entry_id", ""))
                direction = -1 if int(data.get("direction") or 0) < 0 else 1
                index = next((i for i, item in enumerate(room.queue) if item["id"] == entry_id), -1)
                target = index + direction
                if index >= 0 and 0 <= target < len(room.queue):
                    room.queue[index], room.queue[target] = room.queue[target], room.queue[index]
                    await broadcast_room(room)
            elif message_type == "queue_clear" and user_id == room.owner_id:
                room.queue.clear()
                await broadcast_room(room)
            elif message_type in {"play", "pause", "seek", "skip", "sync"} and user_id == room.owner_id:
                if message_type == "skip" or (message_type == "play" and room.current is None):
                    room.current = room.queue.pop(0) if room.queue else None
                    update_playback(room, playing=bool(room.current), position=0)
                elif message_type == "play":
                    update_playback(room, playing=True, position=data.get("position"))
                elif message_type == "pause":
                    update_playback(room, playing=False, position=data.get("position"))
                elif message_type in {"seek", "sync"}:
                    update_playback(room, playing=data.get("playing") if message_type == "sync" else None, position=data.get("position"))
                await broadcast_room(room)
    except WebSocketDisconnect:
        pass
    finally:
        await disconnect_room(room, user_id, websocket)
