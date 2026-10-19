"""Serve the built design study locally, without installing dependencies."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import webbrowser

parser = argparse.ArgumentParser(description="Evelyn CRM Design Preview (synthetische Demodaten)")
parser.add_argument("--port", type=int, default=4173)
parser.add_argument("--no-browser", action="store_true")
options = parser.parse_args()
project = Path(__file__).resolve().parent
if project.name == "scripts":
    project = project.parent
directory = project / "out"
if not (directory / "index.html").is_file():
    parser.error("Statischer Export fehlt. Zuerst npm run build ausführen.")

class PreviewHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'self'; frame-src 'self'; frame-ancestors 'self'")
        super().end_headers()

server = ThreadingHTTPServer(("127.0.0.1", options.port), partial(PreviewHandler, directory=str(directory)))
address = f"http://127.0.0.1:{options.port}/"
print(f"Evelyn Design Preview: {address}\nNur synthetische Demodaten. Beenden mit Strg+C.", flush=True)
if not options.no_browser:
    webbrowser.open(address)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
