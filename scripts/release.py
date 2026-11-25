"""Collect native bundles and publish a single multi-platform updater feed."""
import argparse
import base64
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "package.json").read_text())["version"]
REPO = "IngvarConsulting/naparnik-relay"
TARGETS = {
    "darwin-aarch64": ("macOS-arm64", ".dmg", ".app.tar.gz"),
    "darwin-x86_64": ("macOS-x64", ".dmg", ".app.tar.gz"),
    "windows-x86_64": ("Windows-x64", ".exe", ".exe"),
    "linux-x86_64": ("Linux-x64", ".AppImage", ".AppImage"),
}


def collect(target, bundle, output):
    output.mkdir(parents=True, exist_ok=True)
    label, install_suffix, update_suffix = TARGETS[target]
    prefix = f"Naparnik-Relay-{VERSION}-{label}"
    for suffix in {install_suffix, update_suffix, update_suffix + ".sig"}:
        matches = [f for f in bundle.rglob("*" + suffix)
                   if f.is_file() and len(f.relative_to(bundle).parts) == 2]
        if len(matches) != 1:
            raise ValueError(f"{target}: expected one {suffix} in {bundle}, got {matches}")
        shutil.copyfile(matches[0], output / (prefix + suffix))


def manifest(output):
    platforms = {}
    base = f"https://github.com/{REPO}/releases/download/v{VERSION}/"
    for target, (label, install_suffix, update_suffix) in TARGETS.items():
        prefix = f"Naparnik-Relay-{VERSION}-{label}"
        for suffix in [install_suffix, update_suffix]:
            if (output / (prefix + suffix)).stat().st_size == 0:
                raise ValueError("Empty artifact: " + prefix + suffix)
        name = prefix + update_suffix
        signature = (output / (name + ".sig")).read_text().strip()
        if not base64.b64decode(signature, validate=True).startswith(b"untrusted comment:"):
            raise ValueError("Invalid updater signature format: " + name)
        platforms[target] = {"url": base + name, "signature": signature}
    feed = {"version": VERSION, "pub_date": datetime.now(timezone.utc).isoformat(),
            "notes": f"Naparnik Relay {VERSION}", "platforms": platforms}
    (output / "latest.json").write_text(json.dumps(feed, indent=2) + "\n")
    files = sorted(f for f in output.iterdir() if f.is_file() and f.name != "SHA256SUMS")
    (output / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.name}\n" for f in files))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["collect", "manifest"])
    parser.add_argument("output", type=Path)
    parser.add_argument("--target", choices=TARGETS)
    parser.add_argument("--bundle", type=Path)
    args = parser.parse_args()
    if args.command == "collect":
        collect(args.target, args.bundle, args.output)
    else:
        manifest(args.output)
