"""从 RIPE RIS 提取完整记录前缀，避免下载整个大型路由快照。"""
import gzip
import hashlib
import json
import struct
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "ris-updates": "https://data.ris.ripe.net/rrc00/2025.01/updates.20250101.0000.gz",
    "ris-rib": "https://data.ris.ripe.net/rrc00/2025.01/bview.20250101.0000.gz",
}


def exact(stream, length):
    result = bytearray()
    while len(result) < length:
        chunk = stream.read(length - len(result))
        if not chunk:
            raise ValueError("源文件在记录中途截断")
        result.extend(chunk)
    return bytes(result)


def main():
    directory = ROOT / ".validation"
    directory.mkdir(exist_ok=True)
    manifest = []
    for name, url in SOURCES.items():
        data = bytearray()
        with urllib.request.urlopen(url, timeout=60) as response:
            with gzip.GzipFile(fileobj=response) as stream:
                for _ in range(1000):
                    header = exact(stream, 12)
                    length = struct.unpack("!I", header[8:])[0]
                    if length > 16777216:
                        raise ValueError("记录超过上限")
                    data.extend(header)
                    data.extend(exact(stream, length))
        path = directory / (name + ".mrt")
        path.write_bytes(data)
        item = {"sample": path.name, "source": url, "records": 1000,
                "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        manifest.append(item)
        print(json.dumps(item, ensure_ascii=False))
    (directory / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
