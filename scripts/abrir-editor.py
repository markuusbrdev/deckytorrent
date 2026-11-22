"""Open the catalog editor with local access to this project's files."""

import argparse
import base64
import binascii
import json
import mimetypes
import re
import tempfile
import subprocess
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / "catalogo.json"
MIB = 1024 ** 2
IMAGE = re.compile(r"imagens/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\.(?:png|jpe?g|webp)")
EDITOR_FILES = {"/editor/" + name for name in ("index.html", "editor.js", "editor.css", "catalogo-local.js")}


def atomic_write(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        try:
            handle.write(data)
            handle.flush()
            temporary.chmod(path.stat().st_mode & 0o777 if path.exists() else 0o644)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def safe_image(name):
    if not isinstance(name, str) or not IMAGE.fullmatch(name):
        raise ValueError("Caminho de capa inválido.")
    path = ROOT / name
    if path.resolve() != path:
        raise ValueError("O caminho da capa aponta para outro local.")
    return path


def save(payload):
    previous, catalog = payload["anterior"], payload["catalogo"]
    if not isinstance(previous, str) or not isinstance(catalog, str):
        raise ValueError("Catálogo inválido.")
    encoded = catalog.encode("utf-8")
    if len(encoded) > MIB:
        raise ValueError("O catálogo deve ter até 1 MiB.")
    data = json.loads(catalog)
    if not all(isinstance(data.get(key), list) for key in ("categorias", "pacotes")):
        raise ValueError("O JSON deve conter as listas categorias e pacotes.")
    images = {safe_image(entry["imagem"]) for entry in data["pacotes"]}
    if CATALOG.read_bytes().decode("utf-8") != previous:
        return HTTPStatus.CONFLICT, {"erro": "O catálogo mudou fora do editor. Recarregue a página antes de salvar."}
    created = None
    if image := payload.get("capa"):
        target = safe_image(image["caminho"])
        if target not in images:
            raise ValueError("A capa não está referenciada no catálogo.")
        contents = base64.b64decode(image["dados"], validate=True)
        if not contents or len(contents) > MIB:
            raise ValueError("A capa deve ter até 1 MiB.")
        if target.exists():
            return HTTPStatus.CONFLICT, {"erro": "Esse nome de capa já existe. Tente salvar novamente."}
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as handle:
            created = target
            try:
                handle.write(contents)
            except OSError:
                created.unlink(missing_ok=True)
                raise
    try:
        atomic_write(CATALOG, encoded)
    except OSError:
        if created:
            created.unlink(missing_ok=True)
        raise
    result = {}
    try:
        snapshot = f"globalThis.deckyCatalog = {catalog.strip()};\n"
        atomic_write(ROOT / "editor/catalogo-local.js", snapshot.encode("utf-8"))
    except OSError:
        result["aviso"] = "Catálogo gravado. A cópia offline não pôde ser atualizada."
    return HTTPStatus.OK, result


class EditorHandler(BaseHTTPRequestHandler):
    def reply(self, status, data, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def json_reply(self, status, data):
        self.reply(status, json.dumps(data).encode("utf-8"), "application/json; charset=utf-8")

    def check_host(self):
        if self.headers.get("Host") == self.server.authority:
            return True
        self.send_error(HTTPStatus.FORBIDDEN)
        return False

    def do_GET(self):
        if not self.check_host():
            return
        url = unquote(urlsplit(self.path).path)
        try:
            if url == "/api/catalogo":
                self.reply(HTTPStatus.OK, CATALOG.read_bytes(), "application/json; charset=utf-8")
                return
            if url in EDITOR_FILES:
                path = ROOT / url.lstrip("/")
            elif url.startswith("/imagens/"):
                path = safe_image(url.lstrip("/"))
            else:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            self.reply(HTTPStatus.OK, path.read_bytes(), mime)
        except (OSError, ValueError):
            self.send_error(HTTPStatus.NOT_FOUND)

    do_HEAD = do_GET

    def do_POST(self):
        if not self.check_host():
            return
        if self.path != "/api/catalogo" or self.headers.get("Origin") != self.server.origin:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if self.headers.get_content_type() != "application/json":
            self.send_error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 14 * MIB:
                self.send_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
                return
            status, result = save(json.loads(self.rfile.read(length)))
        except (ValueError, KeyError, TypeError, AttributeError, binascii.Error):
            status, result = HTTPStatus.BAD_REQUEST, {"erro": "Catálogo ou capa inválidos."}
        except OSError:
            status, result = HTTPStatus.INTERNAL_SERVER_ERROR, {"erro": "Não foi possível gravar na pasta do projeto."}
        self.json_reply(status, result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-open", action="store_true", help="Print the URL without opening the browser.")
    args = parser.parse_args()
    with HTTPServer(("127.0.0.1", 0), EditorHandler) as server:
        server.authority = f"127.0.0.1:{server.server_port}"
        server.origin = f"http://{server.authority}"
        url = server.origin + "/editor/index.html"
        print(url, flush=True)
        if not args.no_open:
            try:
                subprocess.Popen(
                    ["firefox", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
            except OSError:
                print("Não foi possível abrir o Firefox. Cole o endereço acima no Firefox.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
