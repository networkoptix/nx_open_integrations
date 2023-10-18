## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import logging
import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def check_status(response):
    if response.status_code == requests.codes.ok:
        logging.debug(f"Request successful\n{response.text}")
        return True

    logging.error(f"{response.url} Request error {response.status_code}\n{response.text}")
    return False

class Session:
    url: str
    verify: bool = False
    token: str = ''
    auth_header: dict = {}

    class RequestException(Exception):
        pass

    def __init__(self, url: str, username: str, password: str):
        self.url = url
        session = self.post('/rest/v1/login/sessions', json={
            'username': username,
            'password': password,
            'setCookie': False
        })
        self.token = session['token']
        self.auth_header = {"Authorization": f"Bearer {self.token}"}

    def __del__(self):
        if self.token:
            self.delete(f'/rest/v1/login/sessions/{self.token}')

    def request(self, uri, method, **kwargs):
        server_url = f'{self.url}{uri}'
        response = requests.request(
            method=method,
            url=server_url,
            verify=self.verify,
            headers=self.auth_header,
            **kwargs
        )
        if not check_status(response):
            raise Exception(f"Request error {response.status_code}\n{response.text}")

        if response.headers.get('Content-Type') == 'application/json':
            return response.json()
        else:
            return response.content

    def get(self, uri, **kwargs):
        return self.request(uri, 'GET', **kwargs)

    def post(self, uri, **kwargs):
        return self.request(uri, 'POST', **kwargs)

    def put(self, uri, **kwargs):
        return self.request(uri, 'PUT', **kwargs)

    def patch(self, uri, **kwargs):
        return self.request(uri, 'PATCH', **kwargs)

    def delete(self, uri, **kwargs):
        return self.request(uri, 'DELETE', **kwargs)
