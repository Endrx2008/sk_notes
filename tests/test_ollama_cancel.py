"""SKAI requests can be cancelled while Ollama is stalled (B-15)."""

from __future__ import annotations

import http.server
import threading
import time
import unittest

from sk_notes.ai import ollama as ol


class Stall(http.server.BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802 - headers, one token, then nothing
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        self.wfile.write(b'{"message":{"content":"hi"}}\n')
        self.wfile.flush()
        time.sleep(30)

    def log_message(self, *a):
        pass


class CancelTests(unittest.TestCase):
    def test_abort_ends_a_stalled_stream_at_once(self):
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Stall)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            client = ol.Ollama()
            client.config = lambda: (f"http://127.0.0.1:{srv.server_port}", "m")
            cancel = threading.Event()
            got: list = []

            def run():
                try:
                    for piece in client.chat_stream([{"role": "user", "content": "x"}], model="m", cancel=cancel):
                        got.append(piece)
                except ol.OllamaError as exc:
                    got.append(exc.kind)

            t = threading.Thread(target=run)
            t.start()
            time.sleep(1)
            t0 = time.time()
            ol.abort(cancel)
            t.join(5)
            self.assertFalse(t.is_alive(), "stream still waiting after abort")
            self.assertLess(time.time() - t0, 2)
            self.assertEqual(got, ["hi", "cancelled"])
        finally:
            srv.shutdown()


if __name__ == "__main__":
    unittest.main()
