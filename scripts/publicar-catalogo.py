"""Publish catalog edits from this checkout to origin/main."""

import argparse
import fcntl
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = "catalogo.json"
BRANCH = "refs/heads/main"
MARKER = "Decky-Catalogo-Automatico: sim"
IMAGE_PATH = re.compile(r"imagens/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\.(webp|jpg|jpeg|png)")


def git(*args):
    result = subprocess.run(
        ["git", *args], cwd=ROOT, capture_output=True, text=True, timeout=45,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        stdin=subprocess.DEVNULL,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Falha no Git.")
    return result.stdout


def catalog_images(content):
    items = json.loads(content)["pacotes"]
    images = {item["imagem"] for item in items}
    if any(not IMAGE_PATH.fullmatch(image) for image in images):
        raise ValueError("O catálogo contém um caminho de capa inválido.")
    return sorted(images)


def local_assets():
    content = (ROOT / CATALOG).read_bytes()
    paths = [CATALOG, *catalog_images(content)]
    for name in paths[1:]:
        path = ROOT / name
        if not path.is_file() or path.resolve() != path:
            raise ValueError(f"Capa ausente ou fora de imagens/: {name}")
    # File changes on the local editor are written before the JSON is replaced.
    stamp = hashlib.sha256(content)
    for name in paths[1:]:
        stat = (ROOT / name).stat()
        stamp.update(f"{name}:{stat.st_size}:{stat.st_mtime_ns}\n".encode())
    return paths, stamp.hexdigest()


def remote_head():
    refs = git("ls-remote", "origin", BRANCH).split()
    if not refs:
        raise RuntimeError("Publique a branch main no origin antes de iniciar o monitor.")
    return refs[0]


def automatic_commit():
    return MARKER in git("log", "-1", "--format=%B").splitlines()


def push_catalog(head):
    committed_assets = catalog_images(git("show", f"{head}:{CATALOG}"))
    tree = set(git("ls-tree", "-r", "--name-only", head, "--", "imagens").splitlines())
    if missing := set(committed_assets) - tree:
        raise RuntimeError(f"O commit ainda não inclui a capa {min(missing)}.")
    git("push", "origin", f"{head}:{BRANCH}")
    print(f"Catálogo publicado na main ({head[:8]}).", flush=True)


def publish(paths, stamp, pending):
    if git("symbolic-ref", "--quiet", "HEAD").strip() != BRANCH:
        raise RuntimeError("Abra a branch main para publicar o catálogo.")
    head = git("rev-parse", "HEAD").strip()
    remote = remote_head()
    if head != remote:
        if pending and automatic_commit() and git("rev-list", "--parents", "-n", "1", head).split()[1:] == [remote]:
            push_catalog(head)
            return
        raise RuntimeError("A main local e a remota estão diferentes. Sincronize-as manualmente para continuar.")

    if not git("status", "--porcelain", "--untracked-files=all", "--", *paths):
        return
    if local_assets()[1] != stamp:
        return

    # Make new covers known to Git without staging other working-tree changes.
    git("add", "--intent-to-add", "--", *paths)
    git("commit", "--only", "-m", "Atualiza catálogo do Decky Torrent", "-m", MARKER, "--", *paths)
    push_catalog(git("rev-parse", "HEAD").strip())


def watch(once):
    last_stamp = None
    last_report = None
    pending_checked = None
    while True:
        try:
            paths, stamp = local_assets()
            head = git("rev-parse", "HEAD").strip()
            pending = head != pending_checked and automatic_commit()
            changed = bool(git("status", "--porcelain", "--untracked-files=all", "--", *paths))
            if once or stamp == last_stamp:
                if pending or changed:
                    publish(paths, stamp, pending)
                pending_checked = git("rev-parse", "HEAD").strip()
                last_report = None
                if once:
                    return
            last_stamp = stamp
            time.sleep(2)
        except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired) as failure:
            message = str(failure)
            if message != last_report:
                print(f"Publicação pendente: {message}", flush=True)
                last_report = message
            if once:
                raise SystemExit(1)
            time.sleep(10)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Check for pending edits and exit.")
    args = parser.parse_args()
    lock_path = Path(git("rev-parse", "--absolute-git-dir").strip()) / "decky-catalogo.lock"
    with lock_path.open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "O monitor do catálogo já está rodando.\n")
        if not args.once:
            print(f"Monitorando {ROOT / CATALOG}. Ctrl+C para encerrar.", flush=True)
        try:
            watch(args.once)
        except KeyboardInterrupt:
            print("\nMonitor encerrado.")


if __name__ == "__main__":
    main()
