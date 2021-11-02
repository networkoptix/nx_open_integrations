import requests
import hashlib
import base64
from pprint import pprint

USERNAME = 'admin'  # local account username or cloud email
PASSWORD = 'pass123'  # local account password or cloud password
SERVER_URL = 'https://localhost:7001'  # https://<server_ip>:<sever_port>
API_URI = '/api/moduleInformation?allModules=true'  # API request URI
API_METHOD = 'GET'  # API request method


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


def check_status(response, verbose):
    if request.status_code == requests.codes.ok:
        if verbose:
            print("Request successful\n{0}".format(request.text))
        return True
    print(request.url + " Request error {0}\n{1}".format(request.status_code, request.text))
    return False


def create_auth():
    response = request_api(SERVER_URL, '/api/getNonce', API_METHOD, verify=False)
    realm = response['reply']['realm']
    nonce = response['reply']['nonce']
    auth = str(digest(USERNAME, PASSWORD, realm, nonce, API_METHOD), 'utf-8')
    return f'?auth={auth}'


def request_api(url, uri, method, auth='', **kwargs):
    server_url = f'{url}{uri}{auth}'
    response = requests.request(method, server_url, **kwargs)
    if not check_status(response, False):
        exit(1)
    if response.headers.get('Content-Type') == 'application/json':
        return response.json()
    else:
        return response.content


def print_system_info(response):
    response_type = type(response['reply'])
    system_info = response['reply']
    if response_type == list:
        number_of_servers = len(system_info)
        system_name = system_info[0]['systemName']
    else:
        number_of_servers = 1
        system_name = system_info['systemName']
    print(f'System {system_name} contains {number_of_servers} server(s):')
    pprint(system_info)


def main():
    system_info = request_api(SERVER_URL, API_URI, API_METHOD, create_auth(), verify=False)
    print_system_info(system_info)


if __name__ == '__main__':
    main()
