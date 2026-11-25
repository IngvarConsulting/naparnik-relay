"""Launch an installed build with an isolated account and check its panel and API."""
import http.cookiejar
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

dist = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = dict(os.environ, RELAY_PORT=str(port), RELAY_DATA_DIR=str(root / "state"))
    if sys.platform == "darwin":
        mount = root / "volume"
        subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, next(dist.glob("*.dmg"))], check=True)
        try:
            app = next(mount.glob("*.app"))
            subprocess.run(["ditto", app, root / app.name], check=True)
        finally:
            subprocess.run(["hdiutil", "detach", mount], check=True)
        binary = next((root / app.name / "Contents/MacOS").iterdir())
    elif sys.platform == "win32":
        install = root / "installed"
        subprocess.run([str(next(dist.glob("*.exe"))), "/S", "/D=" + str(install)], check=True, timeout=180)
        binary = next(p for p in install.glob("*.exe") if "uninstall" not in p.name.lower())
    else:
        binary = next(dist.glob("*.AppImage"))
        binary.chmod(0o755)
        env["APPIMAGE_EXTRACT_AND_RUN"] = "1"
    if sys.platform == "linux":
        args = {"start_new_session": True}
    else:
        args = {}
    proc = subprocess.Popen([str(binary)], env=env, **args)
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(150):
            try:
                with urllib.request.urlopen(url + "/health", timeout=1) as r:
                    if json.load(r)["service"] == "naparnik-relay":
                        break
            except OSError:
                time.sleep(0.3)
        else:
            raise RuntimeError(f"Packaged gateway did not start, exit={proc.poll()}")
        config = json.loads((root / "state/connection.json").read_text())
        panel = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        req = urllib.request.Request(url + "/panel/session", data=json.dumps({"token":config["admin"]}).encode(), headers={"X-Relay-Panel":"1","Content-Type":"application/json"})
        assert json.load(panel.open(req))["ok"]
        assert json.load(panel.open(urllib.request.Request(url+"/panel/state",headers={"X-Relay-Panel":"1"})))["configured"] is False
        req = urllib.request.Request(url + "/v1/models", headers={"Authorization":"Bearer "+config["localKey"]})
        assert json.load(panel.open(req))["data"][0]["id"] == "naparnik"
        for path in ["/naparnik.svg", "/ingvar-consulting.png"]:
            assert len(panel.open(url + path).read()) > 100
        print("Installed application, local session, model and both brand assets passed.")
    finally:
        if sys.platform == "win32":
            subprocess.run(["taskkill","/PID",str(proc.pid),"/T","/F"], check=False)
        elif sys.platform == "linux":
            os.killpg(proc.pid, signal.SIGTERM)
        else:
            proc.terminate()
        proc.wait(timeout=30)
