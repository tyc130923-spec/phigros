#!/usr/bin/env python3
"""Build small first-paint assets without changing the original export sources.

Usage: python scripts/build-hosted-media.py --recording /path/to/reference.mp4
Requires Pillow and ffmpeg. Original chart bytes and skin pixels are preserved.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import zipfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--recording", type=Path)
    args = parser.parse_args()
    source = (ROOT / "js/app.js").read_text()
    match = re.search(r"const BUILTIN_ASSETS\s*=\s*(\[.*?\]);", source, re.S)
    specs = json.loads(match[1])
    originals = {item['id']: item for item in json.loads((ROOT / 'assets/manifest.json').read_text())['entries']}
    manifest = {"version": "4.0.1.2", "artwork": {}, "audio": {}, "charts": {}}
    for folder in ["previews", "stream", "charts/individual", "opening"]:
        (ROOT / "assets" / folder).mkdir(parents=True, exist_ok=True)
    old_chart_bytes = new_chart_bytes = 0
    for spec in specs:
        ident = spec["id"]
        if "_art" in ident:
            im = Image.open(ROOT / spec["url"]).convert("RGB")
            stages = []
            for suffix, width, quality in [("tiny", 96, 55), ("medium", 640, 78), ("clear", im.width, 91)]:
                frame = im.copy()
                frame.thumbnail((width, width))
                path = ROOT / "assets/previews" / f"{ident}-{suffix}.jpg"
                frame.save(path, "JPEG", quality=quality, progressive=True, optimize=True)
                stages.append({"url": "./" + path.relative_to(ROOT).as_posix(), "bytes": path.stat().st_size})
            manifest["artwork"][ident] = {"stages": stages, "original": spec["url"]}
        elif ident.endswith("_music"):
            dest = ROOT / "assets/stream" / f"{ident}.m4a"
            if not dest.exists():
                ffmpeg("-i", ROOT / spec["url"], "-vn", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", dest)
            manifest["audio"][ident] = {"url": "./" + dest.relative_to(ROOT).as_posix(), "duration": spec["duration"], "bytes": dest.stat().st_size, "original": spec["url"]}
        elif ident in originals and originals[ident]['file'].startswith('assets/charts/'):
            # Fetch just the selected difficulty, including on hosts without Range.
            original = originals[ident]
            data = (ROOT / original['file']).read_bytes()
            data = data[original['offset']:original['offset'] + original['bytes']]
            spec['method'] = original['method']
            old_chart_bytes += len(data)
            if spec["method"] == 0:
                data = gzip.compress(data, compresslevel=9, mtime=0)
                spec["method"] = 9
            dest = ROOT / "assets/charts/individual" / f"{ident}.bin"
            dest.write_bytes(data)
            spec["url"] = "./" + dest.relative_to(ROOT).as_posix()
            spec.pop("offset", None)
            spec["byteLength"] = len(data)
            spec["packedSha256"] = hashlib.sha256(data).hexdigest()
            manifest["charts"][ident] = {"url": spec["url"], "bytes": len(data), "method": spec["method"]}
            new_chart_bytes += len(data)
    source = source[:match.start(1)] + json.dumps(specs, ensure_ascii=False, separators=(",", ":")) + source[match.end(1):]
    (ROOT / "js/app.js").write_text(source)
    # Standalone core skin: retain the exact RGBA values, shrink storage with WebP.
    # The full original ZIP remains available for existing import/export workflows.
    skin = {}
    with zipfile.ZipFile(ROOT / "assets/packs/original-skin.zip") as z:
        folder = ROOT / "assets/packs/core"
        folder.mkdir(parents=True, exist_ok=True)
        for name in z.namelist():
            if name == "PROVENANCE.json":
                continue
            data = z.read(name)
            dest = folder / name
            if name.endswith(".png"):
                dest = dest.with_suffix(".webp")
                im = Image.open(io.BytesIO(data)).convert("RGBA")
                im.save(dest, "WEBP", lossless=True, exact=True, method=6)
                assert Image.open(dest).convert("RGBA").tobytes() == im.tobytes()
            else:
                dest.write_bytes(data)
            skin[name] = {"url": "./" + dest.relative_to(ROOT).as_posix(), "bytes": dest.stat().st_size}
    manifest["skin"] = skin
    # Cropped source sprites carry no player's notification, account or watermark.
    if args.recording:
        ffmpeg("-ss", "1.5", "-i", args.recording, "-frames:v", "1", "-vf", "crop=470:80:107:211", ROOT / "assets/opening/studio.webp")
        ffmpeg("-i", ROOT / "assets/ui/d7dd3e86b7a47a5a.webp", "-frames:v", "1", "-vf", "crop=498:134:858:460", ROOT / "assets/opening/logo.webp")
        # Waveform match: t=8s repeats at t=130.739727891s. AAC records the
        # encoder delay/edit list; use an exact sample count for the native loop.
        ffmpeg("-i", args.recording, "-vn", "-af", "atrim=end_sample=5412822,asetpts=PTS-STARTPTS", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", ROOT / "assets/opening/theme.m4a")
    manifest["opening"] = {"audio": "./assets/opening/theme.m4a", "loopSeconds": 122.739727891, "warningAt": 3.4, "titleAt": 8.0, "titleSettledAt": 8.9, "version": "4.0.1.2"}
    (ROOT / "assets/hosted-media.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (ROOT / "js/hosted-manifest.js").write_text("globalThis.PhiHostedManifest=" + json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print(json.dumps({"chartBytesBefore": old_chart_bytes, "chartBytesAfter": new_chart_bytes, "artworks": len(manifest["artwork"]), "songs": len(manifest["audio"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
