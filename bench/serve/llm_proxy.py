# .tmp/bench/llm_proxy.py — 给所有需要 OpenAI 兼容端点的库用的本地代理。
#
# 为什么需要: 上游网关 (ai.woa.qzz.io) 用 Cloudflare 挡了非浏览器 UA (error 1010),
# 而各家库 (mem0/graphiti/cognee) 都不会给你改 UA 的口子。
# 这里做唯一一件事: 转发 + 注入 UA。不改请求体、不改模型名、不缓存。
# 副作用为零, 因此所有对比对象走的是**同一个**上游模型, 变量受控。
import json, os, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("UPSTREAM", "https://ai.woa.qzz.io/v1").rstrip("/")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
PORT = int(os.environ.get("PORT", "4398"))

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass

    def _forward(self, body: bytes | None):
        path = self.path
        # 上游 baseURL 已经带 /v1, 而客户端也会带 /v1 —— 直接拼会变成 /v1/v1/... (实测 404)。
        if UPSTREAM.endswith("/v1") and path.startswith("/v1/"):
            path = path[3:]
        url = UPSTREAM + path
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ("host", "content-length", "user-agent")}
        headers["User-Agent"] = UA
        # 上游会回 gzip; urllib 不解压, 直接转发会让客户端读到二进制 (实测 mem0 报 utf-8 解码失败)。
        headers["Accept-Encoding"] = "identity"
        req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = r.read()
                status, ctype = r.status, r.headers.get("content-type", "application/json")
        except urllib.error.HTTPError as e:
            data, status, ctype = e.read(), e.code, e.headers.get("content-type", "application/json")
        except Exception as e:
            data = json.dumps({"error": {"message": f"proxy: {type(e).__name__}: {e}"}}).encode()
            status, ctype = 502, "application/json"
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self): self._forward(None)
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        self._forward(self.rfile.read(n) if n else b"")

print(f"llm proxy :{PORT} -> {UPSTREAM} (UA injected)", flush=True)
ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
