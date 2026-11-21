import asyncio
import base64
import json
import os
import re
import secrets
import shutil
import socket
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import decky

ROOT = Path(__file__).resolve().parent
STATE = Path(decky.DECKY_PLUGIN_RUNTIME_DIR)
STATUS_KEYS = [
    "gid", "status", "followedBy", "totalLength", "completedLength",
    "downloadSpeed", "errorMessage", "files",
]
TERMINAL = {"complete", "error"}


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     delete=False) as file:
        temporary = Path(file.name)
        try:
            json.dump(value, file, ensure_ascii=False)
            file.flush()
            os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def item_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", value):
        raise ValueError("Use identificadores estáveis com letras minúsculas, números, hífen ou sublinhado.")
    return value


def name(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 150:
        raise ValueError("Nome inválido no catálogo.")
    return value.strip()


def magnet_hash(magnet):
    if not isinstance(magnet, str) or len(magnet) > 8192:
        raise ValueError("Magnet inválido.")
    url = urllib.parse.urlsplit(magnet)
    xt = urllib.parse.parse_qs(url.query).get("xt", [])
    if url.scheme != "magnet" or url.netloc or len(xt) != 1:
        raise ValueError("Use um magnet BitTorrent v1.")
    match = re.fullmatch(r"urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})", xt[0])
    if not match:
        raise ValueError("Hash BitTorrent inválido.")
    value = match[1]
    return value.lower() if len(value) == 40 else base64.b32decode(value, casefold=True).hex()


def validate_catalog(data):
    categories = set()
    for category in data["categorias"]:
        key = item_id(category["id"])
        name(category["nome"])
        if key in categories:
            raise ValueError("Categoria duplicada.")
        categories.add(key)

    ids = set()
    for entry in data["pacotes"]:
        key = item_id(entry["id"])
        name(entry["nome"])
        magnet_hash(entry["magnet"])
        if key in ids or entry["categoria"] not in categories:
            raise ValueError("Pacote duplicado ou categoria inválida.")
        if not re.fullmatch(r"imagens/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\.(webp|jpg|jpeg|png)",
                            entry["imagem"]):
            raise ValueError("Use uma capa PNG, JPEG ou WebP em imagens/.")
        ids.add(key)
    return data


class AriaError(RuntimeError):
    pass


class Aria:
    def __init__(self):
        self.process = None
        self.port = None
        self.secret = secrets.token_hex(32)

    def request(self, method, params):
        body = json.dumps({
            "jsonrpc": "2.0", "id": 1,
            "method": method, "params": ["token:" + self.secret, *params],
        }).encode()
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/jsonrpc", data=body,
            headers={"Content-Type": "application/json"},
        )
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            response = opener.open(request, timeout=3)
        except urllib.error.HTTPError as error:
            with error:
                try:
                    message = json.load(error)["error"]["message"]
                except (ValueError, KeyError, TypeError):
                    raise error
            raise AriaError(message) from error
        with response:
            result = json.load(response)
        if "error" in result:
            raise AriaError(result["error"]["message"])
        return result["result"]

    async def call(self, method, *params):
        return await asyncio.to_thread(self.request, method, params)

    async def start(self):
        if self.process and self.process.returncode is None:
            return
        bundled = ROOT / "bin" / "aria2c"
        if bundled.is_file() and not os.access(bundled, os.X_OK):
            bundled.chmod(bundled.stat().st_mode | 0o100)
        binary = str(bundled) if bundled.is_file() else shutil.which("aria2c")
        if not binary:
            raise RuntimeError("aria2c indisponível. Consulte a instalação no README.")
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        config = STATE / "aria2.conf"
        descriptor = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as file:
            file.write(f"rpc-secret={self.secret}\n")
        self.process = await asyncio.create_subprocess_exec(
            binary, f"--conf-path={config}", "--enable-rpc=true", "--rpc-listen-all=false",
            f"--rpc-listen-port={self.port}", f"--stop-with-process={os.getpid()}",
            "--seed-time=0", "--bt-save-metadata=true", "--auto-file-renaming=false",
            "--check-integrity=true", "--file-allocation=none", "--auto-save-interval=5",
            "--max-download-result=1000", stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        for _ in range(25):
            try:
                await self.call("aria2.getVersion")
                return
            except (OSError, AriaError):
                if self.process.returncode is not None:
                    break
                await asyncio.sleep(0.1)
        await self.stop()
        raise RuntimeError("Não foi possível iniciar o aria2.")

    async def stop(self):
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=2)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()

    async def status(self, gid):
        try:
            return await self.call("aria2.tellStatus", gid, STATUS_KEYS)
        except AriaError as error:
            if "not found" not in str(error).lower():
                raise
            return None

    async def add(self, job):
        options = {
            "dir": job["pasta"], "gid": job["gid"],
            "pause": "true" if job["estado"] == "paused" else "false",
        }
        metadata = Path(job["pasta"]) / (job["hash"] + ".torrent")
        if metadata.is_file():
            torrent = base64.b64encode(metadata.read_bytes()).decode("ascii")
            await self.call("aria2.addTorrent", torrent, [], options)
        else:
            await self.call("aria2.addUri", [job["magnet"]], options)


class Plugin:
    async def _main(self):
        STATE.mkdir(parents=True, exist_ok=True)
        self.jobs_file = STATE / "downloads.json"
        self.jobs = read_json(self.jobs_file) if self.jobs_file.exists() else {}
        self.lock = asyncio.Lock()
        self.catalog_lock = asyncio.Lock()
        self.aria = Aria()
        self.runtime_error = ""
        self.monitor = asyncio.create_task(self.watch())

    async def _unload(self):
        self.monitor.cancel()
        await asyncio.gather(self.monitor, return_exceptions=True)
        await self.aria.stop()

    async def home_folder(self):
        return str(Path.home())

    async def get_catalog(self, refresh):
        async with self.catalog_lock:
            return await asyncio.to_thread(self.load_catalog, refresh)

    def load_catalog(self, refresh):
        config = read_json(ROOT / "configuracao.json")
        url = config.get("urlCatalogo", "").strip()
        cache_path = STATE / "catalogo-cache.json"
        cached = read_json(cache_path) if cache_path.exists() else {}
        if cached.get("url") != url:
            cached = {}
        notice = ""
        if refresh and url:
            try:
                source = urllib.parse.urlsplit(url)
                if source.scheme != "https" or source.hostname != "raw.githubusercontent.com":
                    raise ValueError("Configure a URL HTTPS do arquivo em raw.githubusercontent.com.")
                headers = {"If-None-Match": cached["etag"]} if cached.get("etag") else {}
                request = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(request, timeout=6) as response:
                    body = response.read(1_048_577)
                    if len(body) > 1_048_576:
                        raise ValueError("Catálogo acima do limite de 1 MiB.")
                    data = validate_catalog(json.loads(body.decode("utf-8")))
                    cached = {"url": url, "etag": response.headers.get("ETag"), "data": data}
                save_json(cache_path, cached)
            except urllib.error.HTTPError as error:
                if error.code != 304 or not cached:
                    notice = "Não foi possível atualizar a loja. Exibindo o catálogo salvo."
            except (OSError, ValueError, TypeError, KeyError, AttributeError):
                notice = "Não foi possível atualizar a loja. Exibindo o catálogo salvo."

        raw = cached.get("data") or validate_catalog(read_json(ROOT / "catalogo.json"))
        entries = []
        for entry in raw["pacotes"]:
            cover = ""
            if cached:
                cover = urllib.parse.urljoin(url, entry["imagem"])
            else:
                path = ROOT / entry["imagem"]
                if path.is_file() and path.stat().st_size <= 1_048_576:
                    extension = "jpeg" if path.suffix == ".jpg" else path.suffix[1:]
                    cover = f"data:image/{extension};base64," + base64.b64encode(path.read_bytes()).decode()
            entries.append({**entry, "capa": cover})
        if not url:
            notice = "Catálogo local. A atualização pelo GitHub ainda não foi configurada."
        return {"categorias": raw["categorias"], "pacotes": entries, "aviso": notice}

    async def start_download(self, package_id, folder):
        catalog = await self.get_catalog(False)
        entry = next((item for item in catalog["pacotes"] if item["id"] == package_id), None)
        if entry is None:
            raise ValueError("Este pacote saiu do catálogo. Reabra a Loja.")
        info_hash = magnet_hash(entry["magnet"])
        path = Path(folder).resolve(strict=True)
        if not path.is_dir() or not os.access(path, os.W_OK | os.X_OK):
            raise ValueError("Escolha uma pasta gravável.")
        async with self.lock:
            if any(job["hash"] == info_hash and job["estado"] != "error" for job in self.jobs.values()):
                raise ValueError("Este pacote já está em Meus downloads.")
            await self.aria.start()
            destination = tempfile.mkdtemp(prefix=entry["id"] + "-", dir=path)
            job_id = secrets.token_hex(8)
            job = {
                "id": job_id, "gid": job_id, "nome": entry["nome"], "hash": info_hash,
                "magnet": entry["magnet"], "pasta": destination,
                "estado": "waiting", "baixado": 0, "total": 0, "velocidade": 0,
            }
            self.jobs[job_id] = job
            try:
                save_json(self.jobs_file, self.jobs)
            except OSError:
                del self.jobs[job_id]
                Path(destination).rmdir()
                raise
        return job_id

    async def list_downloads(self):
        async with self.lock:
            public = []
            for job in reversed(list(self.jobs.values())):
                public.append({field: job.get(field) for field in (
                    "id", "nome", "pasta", "estado", "baixado", "total",
                    "velocidade", "erro", "atalho",
                )})
            return {"downloads": public, "aviso": self.runtime_error}

    async def set_paused(self, job_id, pause):
        async with self.lock:
            job = self.jobs[job_id]
            if job["estado"] in TERMINAL:
                raise ValueError("Este download já terminou.")
            await self.aria.start()
            status = await self.aria.status(job["gid"])
            if status and status.get("followedBy"):
                job["gid"] = status["followedBy"][0]
                status = await self.aria.status(job["gid"])
            if status and status["status"] not in TERMINAL:
                if pause and status["status"] != "paused":
                    await self.aria.call("aria2.pause", job["gid"])
                elif not pause and status["status"] == "paused":
                    await self.aria.call("aria2.unpause", job["gid"])
            job.update(estado="paused" if pause else "waiting", velocidade=0)
            save_json(self.jobs_file, self.jobs)

    async def check_executable(self, job_id, selected):
        async with self.lock:
            job = self.jobs[job_id]
            if job["estado"] != "complete":
                raise ValueError("Aguarde a conclusão do download.")
            path = Path(selected).resolve(strict=True)
            folder = Path(job["pasta"])
            if (not path.is_relative_to(folder) or path.suffix.lower() != ".exe"
                    or not path.is_file() or str(path) not in job.get("arquivos", [])):
                raise ValueError("Escolha um .exe que faça parte deste download.")
            return str(path)

    async def save_shortcut(self, job_id, app_id):
        async with self.lock:
            self.jobs[job_id]["atalho"] = app_id
            save_json(self.jobs_file, self.jobs)

    async def watch(self):
        while True:
            events = []
            try:
                async with self.lock:
                    pending = [job for job in self.jobs.values() if job["estado"] not in TERMINAL]
                    if pending:
                        await self.aria.start()
                    for job in pending:
                        if await self.update_job(job):
                            events.append(job["nome"])
                    self.runtime_error = ""
                for title in events:
                    await decky.emit("download_concluido", title)
            except Exception:
                self.runtime_error = "Fila indisponível. Tentando reconectar…"
                decky.logger.exception("Falha ao sincronizar a fila")
            await asyncio.sleep(2)

    async def update_job(self, job):
        status = await self.aria.status(job["gid"])
        if status and status.get("followedBy"):
            job["gid"] = status["followedBy"][0]
            save_json(self.jobs_file, self.jobs)
            status = await self.aria.status(job["gid"])
        if not status:
            if not Path(job["pasta"]).is_dir():
                job.update(velocidade=0, erro="Pasta indisponível. Reconecte o armazenamento.")
                return False
            await self.aria.add(job)
            return False

        state = status["status"]
        if state == "complete" and not status.get("files"):
            return False
        job.update(
            estado="error" if state == "removed" else state,
            baixado=int(status.get("completedLength", 0)), total=int(status.get("totalLength", 0)),
            velocidade=int(status.get("downloadSpeed", 0)), erro=status.get("errorMessage"),
        )
        if state == "complete":
            folder = Path(job["pasta"])
            job["arquivos"] = [
                str(path) for file in status["files"]
                if file.get("path") and (path := Path(file["path"]).resolve()).is_relative_to(folder)
                and path.is_file()
            ]
        save_json(self.jobs_file, self.jobs)
        return state == "complete"
