from threading import Timer
import webbrowser

import uvicorn

from app.config import get_settings


if __name__ == "__main__":
    settings = get_settings()
    browser_host = "127.0.0.1" if settings.server_host in {"0.0.0.0", "::"} else settings.server_host
    browser_url = f"http://{browser_host}:{settings.server_port}"
    print(f"Pulse no desktop: {browser_url}")
    Timer(1.2, lambda: webbrowser.open(browser_url)).start()
    uvicorn.run("app.main:app", host=settings.server_host, port=settings.server_port, reload=True)
