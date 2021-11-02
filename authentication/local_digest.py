import requests
from pprint import pprint
from requests.auth import HTTPBasicAuth, HTTPDigestAuth

USERNAME = 'admin'  # local account username
PASSWORD = 'pass123'  # local account password
SERVER_URL = 'https://localhost:7001'  # https://<server_ip>:<sever_port>
API_URI = '/api/moduleInformation?allModules=true'  # API request URI
API_METHOD = 'GET'  # API request method


def check_status(response, verbose):
    if request.status_code == requests.codes.ok:
        if verbose:
            print("Request successful\n{0}".format(request.text))
        return True
    print(request.url + " Request error {0}\n{1}".format(request.status_code, request.text))
    return False


def request_api(url, uri, method, **kwargs):
    server_url = f'{url}{uri}'
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
    system_info = request_api(SERVER_URL, API_URI, API_METHOD, auth=HTTPDigestAuth(USERNAME, PASSWORD), verify=False)
    print_system_info(system_info)


if __name__ == '__main__':
    main()
