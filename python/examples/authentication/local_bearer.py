import sys
import pathlib
sys.path += [f'{pathlib.Path(__file__).parent.resolve()}/../common']
import server_api as api
from pprint import pprint

USERNAME = 'admin'  # local account username
PASSWORD = 'Admin12345'  # local account password
LOCAL_URL = 'https://localhost:7001'  # https://<server_ip>:<sever_port>

def main():
    user_info = api.request_api(
        LOCAL_URL,
        f'/rest/v2/login/users/{USERNAME}',
        'GET',
        verify=False)
    if not api.is_local_user(user_info):
        print(USERNAME + ' is not a local user.')
        exit(1)

    payload = api.create_auth_payload(USERNAME, PASSWORD)
    token_info = api.request_api(
        LOCAL_URL,
        '/rest/v2/login/sessions',
        'POST',
        verify=False,
        json=payload)
    primary_token = token_info['token']

    primary_token_info = api.request_api(
        LOCAL_URL,
        f'/rest/v2/login/sessions/{primary_token}',
        'GET',
        verify=False)
    if api.is_expired(primary_token_info):
        print('Token has expired')
        exit(1)

    auth_header = api.create_auth_header(primary_token)
    user_list = api.request_api(
        LOCAL_URL,
        f'/rest/v2/users',
        'GET',
        verify=False,
        headers=auth_header)
    api.print_user_list(user_list)

    auth_header = api.create_auth_header(primary_token)
    response = api.request_api(
        LOCAL_URL,
        f'/rest/v2/login/sessions/{primary_token}',
        'DELETE',
        verify=False,
        headers=auth_header)

if __name__ == '__main__':
    main()
