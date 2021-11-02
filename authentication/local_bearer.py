import requests
from pprint import pprint
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

USERNAME = 'admin'  # local account username
PASSWORD = 'qweasd1234'  # local account password
LOCAL_URL = 'https://localhost:7001'  # https://<server_ip>:<sever_port>


def check_status(response, verbose):
    if response.status_code == response.codes.ok:
        if verbose:
            print("Request successful\n{0}".format(response.text))
        return True
    print(response.url + " Request error {0}\n{1}".format(response.status_code, response.text))
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


def print_system_info(response):
    if 'reply' in response:
        system_info = response['reply']
        number_of_servers = len(system_info)
        system_name = system_info[0]['systemName']
    else:
        system_info = response
        number_of_servers = len(system_info)
        system_name = system_info[0]['systemName']
    print(f'System {system_name} contains {number_of_servers} server(s):')
    pprint(system_info)


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

    get_method_header = create_header(primary_token)
    system_info = request_api(LOCAL_URL, f'/rest/v1/servers/*/info', 'GET', verify=False,
                              headers=get_method_header)
    print_system_info(system_info)
    delete_method_header = create_header(secondary_token)

    request_api(LOCAL_URL, f'/rest/v1/login/sessions/{secondary_token}', 'DELETE', verify=False,
                headers=delete_method_header)


if __name__ == '__main__':
    main()
