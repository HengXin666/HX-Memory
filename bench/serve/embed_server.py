# .tmp/bench/embed_server.py — 本地真语义嵌入服务 (OpenAI 兼容 /v1/embeddings)。
# 用途: 给 HX-Memory 的远端嵌入端口和 mem0 的 openai embedder 提供同一个"真语义"后端,
# 保证两边用的是**模型相同**的向量 —— 否则语义通道的对比没有意义。
import os, json
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
from http.server import BaseHTTPRequestHandler, HTTPServer
from fastembed import TextEmbedding

print("loading bge-small-zh-v1.5 ...", flush=True)
MODEL = TextEmbedding(model_name="BAAI/bge-small-zh-v1.5")
DIM = len(next(iter(MODEL.embed(["warmup"]))))
print(f"ready, dim={DIM}", flush=True)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            body = json.dumps({"object": "list", "data": [{"id": "bge-small-zh-v1.5", "object": "model"}]}).encode()
            self.send_response(200); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        texts = req.get("input")
        if isinstance(texts, str): texts = [texts]
        vecs = [v.tolist() for v in MODEL.embed(texts or [])]
        body = json.dumps({"object": "list", "model": req.get("model", "bge-small-zh-v1.5"),
                           "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vecs)],
                           "usage": {"prompt_tokens": 0, "total_tokens": 0}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)

HTTPServer(("127.0.0.1", 4399), H).serve_forever()
