import requests
from datetime import datetime
import json
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

USERNAME = 'admin'  # local account username
PASSWORD = 'pass123'  # local account password
LOCAL_URL = 'https://localhost:7001'  # https://<server_ip>:<sever_port>


def check_status(request, verbose):
    if request.status_code == requests.codes.ok:
        if verbose:
            print("Request successful\n{0}".format(request.text))
        return True
    print(request.url + " Request error {0}\n{1}".format(request.status_code, request.text))
    return False


def request_api(url, uri, method, **kwargs):
    server_url = f'{url}{uri}'
    response = requests.request(
        method,
        server_url,
        **kwargs
    )
    if not check_status(response, False):
        exit(1)
    if response.headers.get('Content-Type') == 'application/json':
        return response.json()
    else:
        return response.content


def is_local_user(api_response):
    if api_response['username'] == 'admin':
        return True
    elif api_response['type'] == 'cloud':
        return False


def create_payload():
    payload = {
        'username': USERNAME,
        'password': PASSWORD,
        'setCookie': False
    }
    return payload


def is_expired(api_response):
    if int(api_response['expiresInS']) < 1:
        return True
    else:
        return False


def create_header(bearer_token):
    header = {"Authorization": f"Bearer {bearer_token}"}
    return header


def main():
    cloud_state = request_api(LOCAL_URL, f'/rest/v1/login/users/{USERNAME}', 'GET', verify=False)
    if not is_local_user(cloud_state):
        print(USERNAME + ' is not a local user.')
        exit(1)

    payload = create_payload()
    primary_session = request_api(LOCAL_URL, '/rest/v1/login/sessions', 'POST', verify=False, json=payload)
    primary_token = primary_session['token']

    secondary_session = request_api(LOCAL_URL, '/rest/v1/login/sessions', 'POST', verify=False, json=payload)
    secondary_token = secondary_session['token']

    primary_token_info = request_api(LOCAL_URL, f'/rest/v1/login/sessions/{primary_token}', 'GET', verify=False)
    if is_expired(primary_token_info):
        print('Expired token')
        exit(1)

    secondary_token_info = request_api(LOCAL_URL, f'/rest/v1/login/sessions/{secondary_token}', 'GET', verify=False)
    if is_expired(secondary_token_info):
        print('Expired token')
        exit(1)

    filename = 'FILENAME'  # replace FILENAME with your backup file
    with open(f'{filename}', 'r') as recovery:
        recovery_file = recovery.read()

    get_method_header = create_header(primary_token)
    request_api(LOCAL_URL, f'/rest/v1/system/database', 'POST', verify=False,
                                headers={**get_method_header, 'Content-type':'application/json'}, data=recovery_file)
    delete_method_header = create_header(secondary_token)

    request_api(LOCAL_URL, f'/rest/v1/login/sessions/{secondary_token}', 'DELETE', verify=False,
                headers=delete_method_header)

if __name__ == '__main__':
    main()
