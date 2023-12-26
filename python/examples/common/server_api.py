## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import logging
import requests
from pprint import pprint 
requests.packages.urllib3.disable_warnings(requests.packages.urllib3.exceptions.InsecureRequestWarning)

RESPONSE_EXPIRATION_TIMEOUT_S = 10

def check_status(response):
    if response.status_code == requests.codes.ok:
        logging.debug(f"Request successful\n{response.text}")
        return True

    logging.error(f"{response.url} Request error {response.status_code}\n{response.text}")
    return False


def request_api(url, uri, method, **kwargs):
    server_url = f'{url}{uri}'
    response = requests.request(
        method,
        server_url,
        **kwargs)

    # Handling Cloud relay redirects. Check for code 307
    if response.status_code == requests.codes.temporary_redirect:
        new_url = response.headers["Location"]
        response = requests.request(
            method,
            new_url,
            **kwargs
        )
    if not check_status(response):
        exit(1)
    if response.headers.get('Content-Type') == 'application/json':
        return response.json()
    else:
        return response.content


def create_cloud_auth_payload(username: str, password: str, cloud_system_id=None):
    payload = {
        'grant_type': 'password',
        'response_type': 'token',
        'client_id': '3rdParty',
        'username': username,
        'password': password
    }
    if cloud_system_id is not None:
        payload['scope'] = f'cloudSystemId={cloud_system_id}'
    return payload


def create_auth_payload(username: str, password: str):
    payload = {
        'username': username,
        'password': password,
        'setCookie': False
    }
    return payload


def get_token(api_response):
    return api_response['access_token']


def is_expired_cloud(api_response):
    if int(api_response['expires_in']) < RESPONSE_EXPIRATION_TIMEOUT_S:
        return True 
    return False


def is_expired(api_response):
    if int(api_response['expiresInS']) < RESPONSE_EXPIRATION_TIMEOUT_S:
        return True 
    return False


def create_auth_header(bearer_token):
    header = {"Authorization": f"Bearer {bearer_token}"}
    return header


def print_system_info(response):
    if 'reply' in response:
        system_info = response['reply']
    else:
        system_info = response
    number_of_servers = len(system_info)
    system_name = system_info[0]['systemName']
    print(f'System {system_name} contains {number_of_servers} server(s):')
    pprint(system_info)


def is_local_user(api_response):
    if api_response['type'] == 'cloud':
        return False
    return True


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
