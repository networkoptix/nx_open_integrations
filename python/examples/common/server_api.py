## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import argparse
import logging
import requests
import hashlib
import base64
from requests.auth import HTTPBasicAuth 
from pprint import pprint
requests.packages.urllib3.disable_warnings(requests.packages.urllib3.exceptions.InsecureRequestWarning)


RESPONSE_EXPIRATION_TIMEOUT_S = 10

def check_status(response):
    if response.status_code == requests.codes.ok or response.status_code == 204:
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
            **kwargs)
    if not check_status(response):
        exit(1)
    if response.headers.get('Content-Type') == 'application/json':
        return response.json()
    else:
        return response.content


def request_api_auth(url, uri, method, auth='', **kwargs):
    server_url = f'{url}{uri}{auth}'
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
            **kwargs)

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


def get_local_ms_token(api_response):
    return api_response['token']


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

def create_auth_for_http_basic_fallback(username: str, password: str, url: str):
    payload = create_auth_payload(username, password)
    token_info = request_api(
        url,
        '/rest/v3/login/sessions',
        'POST',
        verify=False,
        json=payload
        )
    '''
    Notice : 
    * There is no username required, only the session token in the password field.
    * The credential should be {username, password} = {"-", "local_media_server_session_token"}
    '''
    auth = HTTPBasicAuth("-", get_local_ms_token(token_info))
    return auth

def print_system_info(response):
    if 'reply' in response:
        system_info = response['reply']
    else:
        system_info = response
    number_of_servers = len(system_info)
    system_name = system_info[0]['systemName']
    print(f'System {system_name} contains {number_of_servers} server(s):')
    pprint(system_info)


def print_user_list(response):
    if 'reply' in response:
        user_list = response['reply']
    else:
        user_list = response
    number_of_users = len(user_list)
    print(f'\nThis system has {number_of_users} user account(s):\n')
    pprint(user_list)

def is_local_user(api_response):
    if "type" in api_response.keys() and api_response['type'] == 'cloud':
        return False
    return True


def md5(data):
    m = hashlib.md5()
    m.update(data.encode())
    return m.hexdigest()


def digest(login, password, realm, nonce, method):
    login = login.lower()
    dig = md5(f"{login}:{realm}:{password}")
    method = md5(f"{method}:")
    auth_digest = md5(f"{dig}:{nonce}:{method}")
    auth = f"{login}:{nonce}:{auth_digest}".encode()
    return base64.b64encode(auth)


def create_auth(url: str, username: str, password: str):
    response = request_api(url, '/api/getNonce', "GET", verify=False)
    realm = response['reply']['realm']
    nonce = response['reply']['nonce']
    auth = str(digest(username, password, realm, nonce, "GET"), 'utf-8')
    return f'?auth={auth}'

class Session:
    url: str
    verify: bool = False
    token: str = ''
    auth_header: dict = {}

    class RequestException(Exception):
        pass

    @staticmethod
    def add_arguments(parser: argparse.ArgumentParser):
        parser.add_argument(
            '--url',
            type=str, default='https://localhost:7001',
            help="Site URL. Default: https://localhost:7001")
        parser.add_argument(
            '--username',
            type=str, default='admin',
            help="Authentication username. Default: admin")
        parser.add_argument(
            '--password',
            type=str, required=True,
            help="Authentication password")

    @staticmethod
    def from_args(args: argparse.Namespace):
        return Session(args.url, args.username, args.password)

    def __init__(self, url: str, username: str, password: str):
        self.url = url
        session = self.post('/rest/v2/login/sessions', json={
            'username': username,
            'password': password,
            'setCookie': False
        })
        self.token = session['token']
        self.auth_header = {"Authorization": f"Bearer {self.token}"}


    def __del__(self):
        if self.token:
            self.delete(f'/rest/v2/login/sessions/{self.token}')


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
