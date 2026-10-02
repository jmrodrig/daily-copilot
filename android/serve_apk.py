"""Serve the debug APK over HTTP so it can be downloaded from a phone browser.

Usage: python serve_apk.py [--port 8000]
"""

import argparse
import functools
import http.server
import socket
import subprocess
import sys
from pathlib import Path

APK_DIR = Path(__file__).resolve().parent / "app" / "build" / "outputs" / "apk" / "debug"
APK_NAME = "app-debug.apk"


def tailscale_ip():
    try:
        result = subprocess.run(
            ["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    lines = result.stdout.split()
    return lines[0] if lines else None


def lan_ip():
    # Connecting a UDP socket sends nothing; it just selects the outbound interface.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return None


def print_qr(url):
    try:
        import qrcode
    except ImportError:
        return
    qr = qrcode.QRCode(border=1)
    qr.add_data(url)
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        qr.print_ascii(invert=True)
    except (AttributeError, UnicodeEncodeError):
        pass


class APKHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".apk": "application/vnd.android.package-archive",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    if not (APK_DIR / APK_NAME).exists():
        sys.exit(f"APK not found at {APK_DIR / APK_NAME}. Run .\\build.ps1 first.")

    ips = [ip for ip in (tailscale_ip(), lan_ip()) if ip]
    if not ips:
        ips = ["localhost"]
    urls = [f"http://{ip}:{args.port}/{APK_NAME}" for ip in dict.fromkeys(ips)]

    print_qr(urls[0])
    print(f"Scan this or visit {urls[0]} on your phone")
    for url in urls[1:]:
        print(f"  also: {url}")
    print("Press Ctrl+C to stop.")

    handler = functools.partial(APKHandler, directory=str(APK_DIR))
    with http.server.ThreadingHTTPServer(("0.0.0.0", args.port), handler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
