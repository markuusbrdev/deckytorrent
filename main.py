import asyncio
import base64
import json
import os
import re
import secrets
import shutil
import socket
import ssl
import tempfile
import time
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
RELEASE_REPO = "markuusbrdev/deckytorrent"


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
    if not isinstance(data, dict) or not all(isinstance(data.get(key), list) for key in ("categorias", "pacotes")):
        raise ValueError("O catálogo precisa conter as listas categorias e pacotes.")
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
        if not re.fullmatch(r"(?:imagens|images|image)/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\.(webp|jpg|jpeg|png)",
                            entry["imagem"]):
            raise ValueError("Use uma capa PNG, JPEG ou WebP em imagens/, images/ ou image/.")
        ids.add(key)
    return data


def repository_url(raw_url):
    parts = urllib.parse.urlsplit(raw_url).path.strip("/").split("/")
    return f"https://github.com/{parts[0]}/{parts[1]}" if len(parts) >= 4 else ""


def repository_parts(value):
    if not isinstance(value, str) or len(value) > 250:
        raise ValueError("Informe a URL de um repositório público do GitHub.")
    match = re.fullmatch(
        r"https://github\.com/([a-zA-Z0-9][a-zA-Z0-9-]{0,38})/([a-zA-Z0-9_.-]{1,100})/?",
        value.strip(),
    )
    if not match or match[2].removesuffix(".git") in {"", ".", ".."}:
        raise ValueError("Use um endereço como https://github.com/usuario/repositorio.")
    return match[1], match[2].removesuffix(".git")


class NoGitHubRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def github_opener():
    # Decky's embedded Python can use different default CA paths from SteamOS.
    system_ca = Path("/etc/ssl/certs/ca-certificates.crt")
    context = ssl.create_default_context(cafile=str(system_ca) if system_ca.is_file() else None)
    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=context), NoGitHubRedirect(),
    )


def stable_version(value):
    match = re.fullmatch(r"v?(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})", value or "")
    return tuple(map(int, match.groups())) if match else None


def read_release():
    installed = stable_version(read_json(ROOT / "package.json").get("version"))
    if not installed:
        return None
    request = urllib.request.Request(
        f"https://api.github.com/repos/{RELEASE_REPO}/releases/latest",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "Decky-Torrent"},
    )
    with github_opener().open(request, timeout=5) as response:
        release = json.loads(response.read(524_289))
    tag = release.get("tag_name")
    version = stable_version(tag)
    if not version or version <= installed or release.get("draft") or release.get("prerelease"):
        return None
    display = ".".join(map(str, version))
    asset_name = f"decky-torrent-v{display}.zip"
    if not any(asset.get("name") == asset_name and asset.get("state") == "uploaded"
               for asset in release.get("assets", [])):
        return None
    return {"versao": f"v{display}", "url": f"https://github.com/{RELEASE_REPO}/releases/tag/{tag}"}


def read_remote_catalog(url, cached):
    source = urllib.parse.urlsplit(url)
    if source.scheme != "https" or source.netloc != "raw.githubusercontent.com":
        raise ValueError("Configure a URL HTTPS do arquivo em raw.githubusercontent.com.")
    headers = {"Cache-Control": "no-cache"}
    if cached.get("etag"):
        headers["If-None-Match"] = cached["etag"]
    params = urllib.parse.parse_qsl(source.query, keep_blank_values=True)
    params.append(("decky_refresh", str(time.time_ns())))
    request_url = source._replace(query=urllib.parse.urlencode(params)).geturl()
    request = urllib.request.Request(request_url, headers=headers)
    opener = github_opener()
    try:
        with opener.open(request, timeout=6) as response:
            body = response.read(1_048_577)
            if len(body) > 1_048_576:
                raise ValueError("Catálogo acima do limite de 1 MiB.")
            data = validate_catalog(json.loads(body.decode("utf-8")))
            return {"url": url, "etag": response.headers.get("ETag"), "data": data}
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        if status == 304 and cached:
            return cached
        raise


def aria_binary():
    bundled = ROOT / "bin" / "aria2c"
    if bundled.is_file():
        if not os.access(bundled, os.X_OK):
            bundled.chmod(bundled.stat().st_mode | 0o100)
        return str(bundled)
    binary = shutil.which("aria2c")
    if not binary:
        raise RuntimeError("aria2c indisponível. Consulte a instalação no README.")
    return binary


async def aria_command(*args, timeout, capture=False):
    process = await asyncio.create_subprocess_exec(
        aria_binary(), "--no-conf", *args, env={**os.environ, "LC_ALL": "C"},
        stdout=asyncio.subprocess.PIPE if capture else asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), timeout)
    finally:
        if process.returncode is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()
    return output if process.returncode == 0 else None


async def magnet_size(magnet, info_hash):
    with tempfile.TemporaryDirectory(prefix="magnet-", dir=STATE) as directory:
        target = Path(directory)
        await aria_command(
            "--bt-metadata-only=true", "--bt-save-metadata=true", "--seed-time=0",
            "--listen-port=7000-7099", "--dht-listen-port=7100-7199",
            f"--dht-file-path={target / 'dht.dat'}", f"--dht-file-path6={target / 'dht6.dat'}",
            f"--stop-with-process={os.getpid()}", "--stop=20",
            f"--dir={directory}", "--", magnet, timeout=23,
        )
        torrent = target / f"{info_hash}.torrent"
        if not torrent.is_file() or torrent.stat().st_size > 16 * 1024 * 1024:
            return None
        output = await aria_command("--show-files=true", str(torrent), timeout=3, capture=True)
        match = re.search(rb"^Total Length: [^\n]* \(([0-9,]+)\)$", output or b"", re.MULTILINE)
        return int(match[1].replace(b",", b"")) if match else None


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
        binary = aria_binary()
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
        self.release_lock = asyncio.Lock()
        self.release_checked_until = 0
        self.available_release = None
        self.aria = Aria()
        self.size_slots = asyncio.Semaphore(2)
        self.size_tasks = {}
        self.size_retry = {}
        self.sizes_file = STATE / "tamanhos.json"
        try:
            loaded = read_json(self.sizes_file) if self.sizes_file.is_file() else {}
            self.sizes = {
                key: value for key, value in loaded.items() if type(value) is int and value >= 0
            } if isinstance(loaded, dict) else {}
        except (OSError, ValueError):
            self.sizes = {}
        self.runtime_error = ""
        self.monitor = asyncio.create_task(self.watch())

    async def _unload(self):
        tasks = [self.monitor, *self.size_tasks.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.aria.stop()

    async def home_folder(self):
        return str(Path.home())

    async def get_catalog(self, refresh):
        async with self.catalog_lock:
            return await asyncio.to_thread(self.load_catalog, refresh)

    async def get_plugin_update(self):
        async with self.release_lock:
            if time.monotonic() >= self.release_checked_until:
                try:
                    self.available_release = await asyncio.to_thread(read_release)
                    delay = 300
                except (OSError, ValueError, TypeError, AttributeError):
                    delay = 60
                self.release_checked_until = time.monotonic() + delay
            return self.available_release

    async def change_store(self, value):
        owner, repo = repository_parts(value)
        async with self.catalog_lock:
            return await asyncio.to_thread(self._change_store, owner, repo)

    def _change_store(self, owner, repo):
        default_url = read_json(ROOT / "configuracao.json").get("urlCatalogo", "").strip()
        default_repo = repository_url(default_url)
        repo_url = f"https://github.com/{owner}/{repo}"
        active_path = STATE / "loja.json"
        if default_repo and repo_url.casefold() == default_repo.casefold():
            active_path.unlink(missing_ok=True)
            return self.load_catalog(False)

        url = f"https://raw.githubusercontent.com/{owner}/{repo}/HEAD/catalogo.json"
        try:
            candidate = read_remote_catalog(url, {})
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise ValueError("O repositório precisa ser público e ter catalogo.json na raiz.") from error
            raise ValueError("O GitHub não conseguiu carregar o catálogo. Tente novamente.") from error
        except OSError as error:
            raise ValueError("Não foi possível acessar o GitHub. Confira a conexão.") from error
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            raise ValueError("O catalogo.json não está no formato do Decky Torrent.") from error
        save_json(active_path, candidate)
        return self.load_catalog(False)

    def load_catalog(self, refresh, include_covers=True):
        default_url = read_json(ROOT / "configuracao.json").get("urlCatalogo", "").strip()
        active_path = STATE / "loja.json"
        if active_path.is_file():
            cache_path = active_path
            cached = read_json(cache_path)
            url = cached["url"]
        else:
            cache_path = STATE / "catalogo-cache.json"
            url = default_url
            cached = read_json(cache_path) if cache_path.is_file() else {}
            if cached.get("url") != url:
                cached = {}

        notice = ""
        if refresh and url:
            try:
                updated = read_remote_catalog(url, cached)
                if updated is not cached:
                    save_json(cache_path, updated)
                    cached = updated
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
                decky.logger.warning("Falha ao atualizar o catálogo: %s", error)
                notice = "Não foi possível atualizar a loja. Exibindo o catálogo salvo."

        raw = cached.get("data") or validate_catalog(read_json(ROOT / "catalogo.json"))
        if not include_covers:
            return raw
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
        return {
            "categorias": raw["categorias"], "pacotes": entries, "aviso": notice,
            "loja": repository_url(url), "lojaPadrao": repository_url(default_url),
        }

    async def get_package_size(self, package_id, expected_magnet=None):
        async with self.catalog_lock:
            catalog = await asyncio.to_thread(self.load_catalog, False, False)
        entry = next((item for item in catalog["pacotes"] if item["id"] == package_id), None)
        if entry is None or (expected_magnet is not None and entry["magnet"] != expected_magnet):
            return None
        magnet = entry["magnet"]
        info_hash = magnet_hash(magnet)
        for job in self.jobs.values():
            if job["hash"] == info_hash and job.get("total", 0) > 0:
                return job["total"]
        if info_hash in self.sizes:
            return self.sizes[info_hash]
        if self.size_retry.get(info_hash, 0) > asyncio.get_running_loop().time():
            return None
        task = self.size_tasks.get(info_hash)
        if not task:
            task = asyncio.create_task(self._probe_size(magnet))
            self.size_tasks[info_hash] = task
        return await asyncio.shield(task)

    async def _probe_size(self, magnet):
        info_hash = magnet_hash(magnet)
        try:
            async with self.size_slots:
                size = await magnet_size(magnet, info_hash)
            if size is not None:
                self.sizes[info_hash] = size
                try:
                    save_json(self.sizes_file, self.sizes)
                except OSError:
                    decky.logger.warning("Não foi possível salvar o cache de tamanhos.")
                return size
        except (OSError, RuntimeError, asyncio.TimeoutError, ValueError):
            pass
        finally:
            self.size_tasks.pop(info_hash, None)
        self.size_retry[info_hash] = asyncio.get_running_loop().time() + 90
        return None

    async def start_download(self, package_id, folder, expected_magnet=None):
        async with self.catalog_lock:
            catalog = await asyncio.to_thread(self.load_catalog, False, False)
        entry = next((item for item in catalog["pacotes"] if item["id"] == package_id), None)
        if entry is None or (expected_magnet is not None and entry["magnet"] != expected_magnet):
            raise ValueError("Este pacote mudou ou saiu do catálogo. Reabra a Loja.")
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
            folder_stat = Path(destination).stat()
            job = {
                "id": job_id, "gid": job_id, "nome": entry["nome"], "hash": info_hash,
                "magnet": entry["magnet"], "pasta": destination,
                "pasta_identidade": [folder_stat.st_dev, folder_stat.st_ino],
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
                download = {field: job.get(field) for field in (
                    "id", "nome", "pasta", "estado", "baixado", "total",
                    "velocidade", "erro", "atalho", "apagando",
                )}
                download["temExecutavel"] = job["estado"] == "complete" and any(
                    Path(file).suffix.lower() == ".exe" and Path(file).is_file()
                    for file in job.get("arquivos", [])
                )
                public.append(download)
            return {"downloads": public, "aviso": self.runtime_error}

    async def set_paused(self, job_id, pause):
        async with self.lock:
            job = self.jobs[job_id]
            if job.get("apagando"):
                raise ValueError("Este download está com a exclusão pendente.")
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

    def _download_folder(self, job):
        folder = Path(job["pasta"])
        if (not folder.is_absolute() or folder.resolve() != folder
                or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}-[a-z0-9_]{8}", folder.name)):
            raise ValueError("A pasta do download não é uma subpasta válida do plugin.")
        if not folder.parent.is_dir():
            raise ValueError("Reconecte o armazenamento para apagar a pasta do download.")
        if any(other is not job and Path(other["pasta"]).is_relative_to(folder)
               for other in self.jobs.values()):
            raise ValueError("A pasta contém outro download registrado.")
        if folder.exists():
            stat = folder.stat()
            identity = job.get("pasta_identidade")
            if not folder.is_dir() or folder.is_mount() or (
                identity is not None and identity != [stat.st_dev, stat.st_ino]
            ):
                raise ValueError("A pasta do download foi substituída ou é um ponto de montagem.")
        return folder

    async def _stop_download(self, job):
        if not self.aria.process or self.aria.process.returncode is not None:
            return
        gid = job["gid"]
        requested = set()
        for _ in range(30):
            status = await self.aria.status(gid)
            if not status or status["status"] in {"removed", "error"}:
                return
            if status.get("followedBy"):
                gid = status["followedBy"][0]
                continue
            if status["status"] == "complete":
                if any(file.get("path") and Path(file["path"]).is_relative_to(job["pasta"])
                       for file in status.get("files", [])):
                    job["gid"] = gid
                    await self.update_job(job)
                    raise ValueError("O download foi concluído. Confirme novamente para remover só da lista.")
                return
            if gid not in requested:
                try:
                    await self.aria.call("aria2.forceRemove", gid)
                    requested.add(gid)
                except AriaError:
                    # A metadata transfer can finish as the removal request reaches aria2.
                    latest = await self.aria.status(gid)
                    if latest and latest["status"] == status["status"] and not latest.get("followedBy"):
                        raise
            await asyncio.sleep(0.2)
        raise RuntimeError("Não foi possível parar a transferência. Tente apagar novamente.")

    async def delete_download(self, job_id, delete_files):
        async with self.lock:
            job = self.jobs.get(job_id)
            if job is None:
                return
            if delete_files != (job["estado"] != "complete"):
                raise ValueError("O estado do download mudou. Confirme novamente.")

            if delete_files:
                self._download_folder(job)
                await self._stop_download(job)
                if not job.get("apagando"):
                    job["apagando"] = True
                    try:
                        save_json(self.jobs_file, self.jobs)
                    except OSError:
                        job.pop("apagando")
                        raise
                try:
                    folder = self._download_folder(job)
                    if folder.exists():
                        await asyncio.to_thread(shutil.rmtree, folder)
                except OSError as error:
                    raise RuntimeError("Não foi possível apagar a pasta. Tente novamente.") from error

            remaining = {key: entry for key, entry in self.jobs.items() if key != job_id}
            save_json(self.jobs_file, remaining)
            self.jobs = remaining

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
                    pending = [
                        job for job in self.jobs.values()
                        if job["estado"] not in TERMINAL and not job.get("apagando")
                    ]
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
