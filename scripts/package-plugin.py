"""Build a Decky install ZIP from the compiled frontend and a local aria2c."""

import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
FOLDER = "decky-catalogo"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--aria2", type=Path, required=True, help="Portable Linux x86-64 aria2c")
    parser.add_argument("--aria2-source", type=Path, required=True, help="Source bundle for the supplied aria2c")
    parser.add_argument("--output", type=Path, default=ROOT / "release")
    args = parser.parse_args()

    version = json.loads((ROOT / "package.json").read_text())["version"]
    output = args.output / f"decky-torrent-v{version}.zip"
    files = {
        name: ROOT / name
        for name in (
            "plugin.json", "package.json", "main.py", "configuracao.json",
            "catalogo.json", "LICENSE", "README.md", "dist/index.js",
        )
    }
    if (ROOT / "dist/index.js.map").is_file():
        files["dist/index.js.map"] = ROOT / "dist/index.js.map"
    for path in sorted((ROOT / "imagens").rglob("*")):
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
            files[path.relative_to(ROOT).as_posix()] = path
    files[f"third-party/{args.aria2_source.name}"] = args.aria2_source
    files["bin/aria2c"] = args.aria2
    for path in files.values():
        if not path.is_file():
            parser.error(f"Missing file: {path}")

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".tmp")
    try:
        with ZipFile(temporary, "w", ZIP_DEFLATED) as archive:
            for name, path in files.items():
                item = ZipInfo(f"{FOLDER}/{name}")
                item.create_system = 3
                item.external_attr = (0o100755 if name == "bin/aria2c" else 0o100644) << 16
                archive.writestr(item, path.read_bytes(), compress_type=ZIP_DEFLATED)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(output)


if __name__ == "__main__":
    main()
