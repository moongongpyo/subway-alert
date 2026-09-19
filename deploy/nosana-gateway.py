"""Private proxy for the two direct Nosana deployments (stdlib only)."""
import hashlib, hmac, http.server, json, os, re, urllib.request, urllib.error


class Gateway(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, data, kind='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def handle_request(self):
        if self.path == '/health' and self.command == 'GET':
            return self.reply(200, b'{"ok":true}')
        supplied = self.headers.get('Authorization', '').removeprefix('Bearer ')
        if not hmac.compare_digest(hashlib.sha256(supplied.encode()).hexdigest(), os.environ['INFERENCE_TOKEN_SHA256']):
            return self.reply(401, b'{"error":"Unauthorized"}')
        mode = os.environ.get('INFERENCE_MODE', 'llm')
        allowed = (self.command, self.path) in [('POST', '/api/chat'), ('GET', '/api/tags')] if mode == 'llm' else (
            (self.command == 'POST' and self.path in ['/prompt', '/history', '/queue']) or
            (self.command == 'GET' and re.fullmatch(r'/(object_info/CheckpointLoaderSimple|history/[a-zA-Z0-9-]+|view\?[^#]+)', self.path)))
        if not allowed:
            return self.reply(404, b'{"error":"Not found"}')
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if size < 0 or size > 3500000:
                return self.reply(413, b'{"error":"Request too large"}')
            body = self.rfile.read(size) if self.command == 'POST' else None
            if body and mode == 'llm':
                payload = json.loads(body)
                if payload.get('model') != os.environ['INFERENCE_MODEL']:
                    return self.reply(400, b'{"error":"Model not deployed"}')
                options = payload.get('options', {})
                if payload.get('stream') is not False or not 1 <= options.get('num_predict', 0) <= 8000:
                    return self.reply(400, b'{"error":"Bounded requests required"}')
                options['num_ctx'] = 32768
                payload['options'] = options
                body = json.dumps(payload).encode()
            request = urllib.request.Request('http://127.0.0.1:' + os.environ['UPSTREAM_PORT'] + self.path,
                                             data=body, headers={'Content-Type': 'application/json'}, method=self.command)
            with urllib.request.urlopen(request, timeout=180) as response:
                self.reply(response.status, response.read(8000000), response.headers.get('Content-Type', 'application/json'))
        except urllib.error.HTTPError as error:
            self.reply(error.code, b'{"error":"Inference request failed"}')
        except Exception:
            self.reply(502, b'{"error":"Inference server unavailable"}')

    do_GET = handle_request
    do_POST = handle_request


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('0.0.0.0', 8000), Gateway).serve_forever()
