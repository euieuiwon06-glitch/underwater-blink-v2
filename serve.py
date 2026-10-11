# 수정한 파일이 바로 반영되도록 캐시를 끄고 dist 폴더를 띄우는 로컬 서버
import functools
import http.server
import pathlib

PORT = 8792
ROOT = pathlib.Path(__file__).resolve().parent / "dist"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


handler = functools.partial(NoCacheHandler, directory=str(ROOT))
with http.server.ThreadingHTTPServer(("localhost", PORT), handler) as server:
    print(f"http://localhost:{PORT}  (창을 닫으면 서버가 꺼집니다)")
    server.serve_forever()
