#!/usr/bin/env python

## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import configparser
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import logging
import logging.handlers
from pathlib import Path
import requests
import sys
import time
import traceback
from typing import Dict, Optional


PROGRAM_NAME = 'http_proxy_with_feedback'


@dataclass
class Config:
    vms_user: str
    vms_password: str
    vms_port: int = 7001
    vms_address: str = None
    proxy_port: int = 8000
    log_level: str = 'INFO'


CONFIG: Config = None


def run(server_class=HTTPServer, handler_class=BaseHTTPRequestHandler):
    server_address = ('', CONFIG.proxy_port)
    httpd = server_class(server_address, handler_class)
    try:
        logging.info(f'Start listening on :{CONFIG.proxy_port}')
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()


class HttpGetHandler(BaseHTTPRequestHandler):
    def log_message(self, _, *args):
        logging.debug('HTTP server message: ' + ' '.join(args))

    def do_GET(self):
        client_address, client_port = self.client_address
        logging.info(f'Request {self.requestline!r} from {client_address}:{client_port}')
        if not (target_url := self._get_target_url_from_request_path()):
            self._send_bad_request_response()
            return

        try:
            logging.info(f'Sending request: {target_url}')
            response = requests.get(target_url, headers={n: v for n, v in self.headers.items()})
            response.raise_for_status()
        except requests.URLRequired:
            self._send_bad_request_response()
            return
        except requests.exceptions.RequestException as e:
            create_failed_request_event(vms_address=client_address, target_url=target_url, error=e)
            self._send_bad_reply_response(e)
            return

        self._send_target_response(response)

    def _get_target_url_from_request_path(self):
        request_start_token = '?request='
        if (request_start_position := self.path.find(request_start_token)) == -1:
            return None
        return self.path[request_start_position+len(request_start_token):]

    def _send_bad_request_response(self):
        self.send_response(400)
        self.send_header('Content-type', 'text/plain')
        self.end_headers()
        self.wfile.write(f'Bad request {self.requestline!r}: target URL not found'.encode())

    def _send_bad_reply_response(self, error: requests.exceptions.RequestException):
        if error.response is not None:
            self._send_target_response(error.response)
            return

        self.send_response(400)
        self.send_header('Content-type', 'text/plain')
        self.end_headers()
        self.wfile.write(str(error).encode())

    def _send_target_response(self, target_response: requests.Response):
        self.send_response(target_response.status_code)
        for n, v in target_response.headers.items():
            self.send_header(n, v)
        self.end_headers()
        self.wfile.write(target_response.content)


def create_failed_request_event(
        vms_address: str, target_url: str, error: requests.exceptions.RequestException):
    def request_server(
            url: str,
            data: Dict[str, str],
            headers: Dict[str, str] = None) -> Optional[Dict[str, str]]:
        if headers is None:
            headers = {}
        headers['Content-type'] = 'application/json'
        try:
            response = requests.post(url, verify=False, headers=headers, data=json.dumps(data))
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            logging.error(f'Request to Server failed: {e}')
            return None
        return response.json()

    logging.info('Creating error notification on Server')
    vms_url = f'https://{vms_address}:{CONFIG.vms_port}'

    logging.debug('Log in to Server')
    login_data = request_server(
        url=f'{vms_url}/rest/v2/login/sessions',
        data={'username': CONFIG.vms_user, 'password': CONFIG.vms_password})
    if login_data is None:
        return

    logging.debug('Create generic event on Server')
    request_server(
        url=f'{vms_url}/api/createEvent',
        data={
            'source': PROGRAM_NAME,
            'timestamp': str(int(time.time() * 1000)),  # Time in milliseconds.
            'caption': f'HTTP request to {target_url} is failed',
            'description': str(error),
        },
        headers={'Authorization': f'Bearer {login_data["token"]}'})


def load_config():
    if getattr(sys, 'frozen', False):
        # If the application is run as a bundle, the PyInstaller bootloader extends the sys module
        # with the flag frozen=True.
        application_path = Path(sys.executable)
    else:
        application_path = Path(__file__)

    config_file = application_path.resolve().parent / f'{PROGRAM_NAME}.conf'
    config = configparser.ConfigParser()
    config.read(config_file)

    global CONFIG
    CONFIG = Config(vms_user=config.get('vms', 'user'), vms_password=config.get('vms', 'password'))
    if vms_port := config.get('vms', 'port', fallback=None):
        CONFIG.vms_port = vms_port
    if vms_address := config.get('vms', 'address', fallback=None):
        CONFIG.vms_address = vms_address

    if config.has_section('general'):
        if proxy_port := config.get('general', 'port', fallback=None):
            CONFIG.proxy_port = proxy_port
        if log_level := config.get('general', 'log_level', fallback=None):
            CONFIG.log_level = log_level


def main():
    logging.basicConfig(
        level=logging.DEBUG,
        format='%(asctime)s %(levelname)s\t%(message)s',
        handlers=[
            logging.handlers.RotatingFileHandler(f'{PROGRAM_NAME}.log'),
            logging.StreamHandler(),
        ])
    load_config()
    logging.setLevel(logging.getLevelName(CONFIG.log_level))
    run(handler_class=HttpGetHandler)


try:
    main()
except Exception as e:
    logging.debug(traceback.format_exc())
    sys.exit(f'An error occurred: {e}')
