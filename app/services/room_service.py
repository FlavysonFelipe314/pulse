import asyncio
import secrets
import string
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket


@dataclass
class ListeningRoom:
    code: str
    name: str
    owner_id: int
    owner_name: str
    queue_policy: str = "everyone"
    members: dict[int, str] = field(default_factory=dict)
    connections: dict[int, set[WebSocket]] = field(default_factory=dict)
    queue: list[dict[str, Any]] = field(default_factory=list)
    pending_requests: list[dict[str, Any]] = field(default_factory=list)
    current: dict[str, Any] | None = None
    playing: bool = False
    position: float = 0.0
    updated_at: float = field(default_factory=time.time)
    messages: list[dict[str, Any]] = field(default_factory=list)

    def playback_position(self) -> float:
        if self.playing:
            return max(0.0, self.position + time.time() - self.updated_at)
        return max(0.0, self.position)

    def snapshot(self) -> dict[str, Any]:
        return {
            "type": "room_state",
            "room": {"code": self.code, "name": self.name, "owner_id": self.owner_id, "owner_name": self.owner_name, "queue_policy": self.queue_policy},
            "participants": [{"id": user_id, "display_name": name, "online": bool(self.connections.get(user_id))} for user_id, name in self.members.items()],
            "queue": self.queue,
            "pending_requests": self.pending_requests,
            "current": self.current,
            "playing": self.playing,
            "position": self.playback_position(),
            "server_time": time.time(),
            "messages": self.messages[-50:],
        }


ROOMS: dict[str, ListeningRoom] = {}
ROOMS_LOCK = asyncio.Lock()


def new_room_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        if code not in ROOMS:
            return code


async def create_room(owner_id: int, owner_name: str, name: str, queue_policy: str = "everyone") -> ListeningRoom:
    async with ROOMS_LOCK:
        room = ListeningRoom(code=new_room_code(), name=name, owner_id=owner_id, owner_name=owner_name, queue_policy=queue_policy)
        room.members[owner_id] = owner_name
        ROOMS[room.code] = room
        return room


def get_room(code: str) -> ListeningRoom | None:
    return ROOMS.get(code.upper())


def add_room_member(room: ListeningRoom, user_id: int, display_name: str) -> None:
    room.members[user_id] = display_name


def can_access_room_media(code: str, user_id: int, music_id: int) -> bool:
    room = get_room(code)
    if not room or user_id not in room.members:
        return False
    if room.current and room.current.get("music", {}).get("id") == music_id:
        return True
    return any(item.get("music", {}).get("id") == music_id for item in room.queue)


async def connect_room(room: ListeningRoom, user_id: int, websocket: WebSocket) -> None:
    await websocket.accept()
    room.connections.setdefault(user_id, set()).add(websocket)
    await websocket.send_json(room.snapshot())
    await broadcast_room(room)


async def disconnect_room(room: ListeningRoom, user_id: int, websocket: WebSocket) -> None:
    connections = room.connections.get(user_id)
    if connections:
        connections.discard(websocket)
        if not connections:
            room.connections.pop(user_id, None)
    await broadcast_room(room)


async def broadcast_room(room: ListeningRoom, payload: dict[str, Any] | None = None) -> None:
    message = payload or room.snapshot()
    dead: list[tuple[int, WebSocket]] = []
    for user_id, sockets in list(room.connections.items()):
        for socket in list(sockets):
            try:
                await socket.send_json(message)
            except Exception:
                dead.append((user_id, socket))
    for user_id, socket in dead:
        room.connections.get(user_id, set()).discard(socket)


def update_playback(room: ListeningRoom, playing: bool | None = None, position: float | None = None) -> None:
    room.position = room.playback_position() if position is None else max(0.0, float(position))
    if playing is not None:
        room.playing = playing
    room.updated_at = time.time()


def queue_entry(music: dict[str, Any], user_id: int, display_name: str) -> dict[str, Any]:
    safe_music = dict(music)
    if hasattr(safe_music.get("added_at"), "isoformat"):
        safe_music["added_at"] = safe_music["added_at"].isoformat()
    return {"id": uuid.uuid4().hex, "music": safe_music, "added_by": {"id": user_id, "display_name": display_name}}
