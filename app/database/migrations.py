from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine


def migrate_existing_database(engine: Engine) -> None:
    """Small additive migration for databases created before accounts existed."""
    if engine.dialect.name != "sqlite":
        return
    additions = {
        "playlists": "user_id INTEGER REFERENCES users(id) ON DELETE CASCADE",
        "folders": "user_id INTEGER REFERENCES users(id) ON DELETE CASCADE",
        "playback_history": "user_id INTEGER REFERENCES users(id) ON DELETE CASCADE",
    }
    with engine.begin() as connection:
        inspector = inspect(connection)
        tables = set(inspector.get_table_names())
        for table, definition in additions.items():
            if table not in tables:
                continue
            columns = {column["name"] for column in inspector.get_columns(table)}
            if "user_id" not in columns:
                connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {definition}"))
        if "playlists" in tables:
            playlist_columns = {column["name"] for column in inspector.get_columns("playlists")}
            if "is_public" not in playlist_columns:
                connection.execute(text("ALTER TABLE playlists ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT 0"))
        if "music" in tables:
            music_columns = {column["name"] for column in inspector.get_columns("music")}
            music_additions = {
                "lyrics_provider_id": "INTEGER",
                "plain_lyrics": "TEXT",
                "synced_lyrics": "TEXT",
                "lyrics_checked_at": "DATETIME",
                "lyrics_query_key": "VARCHAR(64)",
            }
            for column, definition in music_additions.items():
                if column not in music_columns:
                    connection.execute(text(f"ALTER TABLE music ADD COLUMN {column} {definition}"))
