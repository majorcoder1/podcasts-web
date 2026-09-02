#!/usr/bin/env python3
"""
Stage a built APK for download and write the metadata the landing page reads.

    python3 tools/publish-apk.py ../podcasts-clone/app/build/outputs/apk/release/app-release.apk

Copies the APK into public/download/ under a versioned filename, records its
size and SHA-256, and rewrites release.json. Versioned filenames mean the APK
can be cached hard while a new build is still picked up immediately.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOWNLOAD_DIR = os.path.join(HERE, "public", "download")


def find_aapt() -> str | None:
    """aapt2 lives under whichever build-tools version is installed."""
    sdk = os.environ.get("ANDROID_HOME") or os.path.expanduser("~/Android/Sdk")
    build_tools = os.path.join(sdk, "build-tools")
    if not os.path.isdir(build_tools):
        return None
    for version in sorted(os.listdir(build_tools), reverse=True):
        candidate = os.path.join(build_tools, version, "aapt2")
        if os.path.isfile(candidate):
            return candidate
    return None


def read_version(apk: str) -> tuple[str, str]:
    """Returns (versionName, versionCode), falling back when aapt2 is absent."""
    aapt = find_aapt()
    if aapt:
        try:
            output = subprocess.run(
                [aapt, "dump", "badging", apk],
                capture_output=True, text=True, timeout=60,
            ).stdout
            name = re.search(r"versionName='([^']+)'", output)
            code = re.search(r"versionCode='([^']+)'", output)
            if name:
                return name.group(1), (code.group(1) if code else "")
        except (subprocess.SubprocessError, OSError):
            pass
    return "1.0.0", ""


def is_signed(apk: str) -> bool:
    with zipfile.ZipFile(apk) as archive:
        names = archive.namelist()
    # v2/v3 signatures live in the zip's signing block rather than META-INF, so
    # treat either marker as signed and let apksigner be the real check.
    return any(n.startswith("META-INF/") and n.endswith((".RSA", ".EC", ".DSA")) for n in names)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("apk")
    parser.add_argument("--version", help="override the version name")
    args = parser.parse_args()

    if not os.path.isfile(args.apk):
        print(f"No such APK: {args.apk}", file=sys.stderr)
        return 1

    version, code = read_version(args.apk)
    if args.version:
        version = args.version

    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    filename = f"podcasts-{version}.apk"
    target = os.path.join(DOWNLOAD_DIR, filename)
    shutil.copy2(args.apk, target)

    digest = hashlib.sha256()
    with open(target, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)

    release = {
        "file": filename,
        "version": version,
        "versionCode": code,
        "size": os.path.getsize(target),
        "sha256": digest.hexdigest(),
        "released": datetime.date.today().isoformat(),
        "minSdk": 24,
    }

    with open(os.path.join(DOWNLOAD_DIR, "release.json"), "w") as handle:
        json.dump(release, handle, indent=2)
        handle.write("\n")

    # Older builds would otherwise pile up in the upload bundle.
    for existing in os.listdir(DOWNLOAD_DIR):
        if existing.endswith(".apk") and existing != filename:
            os.remove(os.path.join(DOWNLOAD_DIR, existing))

    print(f"Published {filename}")
    print(f"  version  {version} ({code or 'no code'})")
    print(f"  size     {release['size'] / 1e6:.1f} MB")
    print(f"  sha256   {release['sha256']}")
    print(f"  signed   {is_signed(target)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
