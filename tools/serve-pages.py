#!/usr/bin/env python3
"""Serve a directory the way GitHub Pages serves this repo, for local previews.

    python3 tools/serve-pages.py [DIR] [--port 8021] [--host 0.0.0.0]

* A file is served as itself; /about also finds about.html.
* A folder is served by its index.html (/docs -> 301 /docs/); a folder
  without one, and any path that is not there, gets 404.html with status
  404, which is how /<barber-slug> links reach 404.html's redirect.
* No folder listings. Every answer says Cache-Control: no-cache, so an edit
  shows on the next reload.

Binds 0.0.0.0 by default, so a phone on the tailnet can open it.
"""

import argparse
import io
import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class PagesHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def send_head(self):
        url = urlsplit(self.path)
        local = self.translate_path(url.path)
        if os.path.isdir(local):
            if not os.path.isfile(os.path.join(local, 'index.html')):
                return self.not_found()
            if not url.path.endswith('/'):
                self.send_response(301)
                self.send_header('Location', url.path + '/' + (f'?{url.query}' if url.query else ''))
                self.send_header('Content-Length', '0')
                self.end_headers()
                return None
            return super().send_head()
        if os.path.isfile(local):
            return super().send_head()
        if os.path.isfile(local + '.html'):
            self.path = url.path + '.html' + (f'?{url.query}' if url.query else '')
            return super().send_head()
        return self.not_found()

    def not_found(self):
        page = os.path.join(self.directory, '404.html')
        body = open(page, 'rb').read() if os.path.isfile(page) else b'Not found'
        self.send_response(404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command == 'HEAD':
            return None
        return io.BytesIO(body)

    def list_directory(self, path):
        return self.not_found()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('directory', nargs='?', default=os.getcwd())
    parser.add_argument('--port', type=int, default=8021)
    parser.add_argument('--host', default='0.0.0.0')
    args = parser.parse_args()
    directory = os.path.abspath(args.directory)
    handler = partial(PagesHandler, directory=directory)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f'Serving {directory} like GitHub Pages on http://{args.host}:{args.port}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
