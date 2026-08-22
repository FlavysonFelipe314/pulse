# Pulse

Player pessoal de música com biblioteca local, playlists e pesquisa pela API oficial do YouTube. Antes de reproduzir, o usuário deve importar o áudio com confirmação explícita de que possui direitos ou autorização. O projeto não contorna DRM, paywalls ou restrições técnicas.

## Executar

1. Ative o ambiente virtual (PowerShell):

   ```powershell
   .\venv\Scripts\Activate.ps1
   ```

2. Crie o arquivo de configuração e informe uma chave da YouTube Data API v3:

   ```powershell
   Copy-Item .env.example .env
   ```

   ```env
   YOUTUBE_API_KEY=sua_chave
   DATABASE_URL=sqlite:///./pulse.db
   ```

3. Instale o FFmpeg, necessário para preparar o áudio em MP3. No Windows com Chocolatey:

   ```powershell
   choco install ffmpeg
   ```

4. Instale as dependências e execute:

   ```powershell
   pip install -r requirements.txt
   python run.py
   ```

5. Abra `http://127.0.0.1:8000`.

O banco e as tabelas são criados automaticamente no primeiro início. Para PostgreSQL, troque `DATABASE_URL` por uma URL SQLAlchemy compatível e instale o driver correspondente.

## Estrutura

- `app/api`: endpoints por domínio;
- `app/models` e `app/schemas`: persistência e contratos;
- `app/services`: pesquisa do YouTube, biblioteca e fronteira de mídia legal;
- `app/templates` e `app/static`: interface responsiva e controlador do player;
- `app/storage/music`: mídia privada, servida apenas por identificadores controlados.

Atalhos: `Espaço` reproduz/pausa, setas avançam ou voltam 10 segundos e `Ctrl/Cmd + K` abre a pesquisa.
