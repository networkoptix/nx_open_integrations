import requests
from pprint import pprint

CLOUD_USER = 'user@gmail.com'  # cloud account email
CLOUD_PASSWORD = 'pass123'  # cloud account password
LOCAL_URL = 'https://localhost:7001'  # https://<server_ip>:<sever_port>
CLOUD_DOMAIN_NAME = 'nxvms.com'  # Cloud service domain name
CLOUD_URL = 'https://' + CLOUD_DOMAIN_NAME


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


def get_cloud_system_id(api_response):
    return api_response['cloudId']


def has_cloud_host(api_response):
    return api_response['cloudHost'] == CLOUD_DOMAIN_NAME


def is_cloud_user(api_response):
    if api_response['type'] != 'cloud':
        return False
    else:
        return True


def create_payload(cloud_system_id=None):
    if cloud_system_id is not None:
        scope = f'cloudSystemId={cloud_system_id}'
    else:
        scope = f'https://nxvms.com/cdb/oauth2/'
    return {
        'grant_type': 'password', 'response_type': 'token', 'client_id': '3rdParty',
        'scope': scope,
        'username': CLOUD_USER, 'password': CLOUD_PASSWORD
    }


def get_token(api_response):
    if int(api_response['expires_in']) < 1:
        print('Expired token')
        exit(1)
    bearer_token = api_response['access_token']
    return bearer_token


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
    else:
        system_info = response
    number_of_servers = len(system_info)
    system_name = system_info[0]['systemName']
    print(f'System {system_name} contains {number_of_servers} server(s):')
    pprint(system_info)


def main():
    system_info = request_api(LOCAL_URL, '/rest/v1/system/info', 'GET', verify=False)
    if not has_cloud_host(system_info):
        print('Not a cloud-connected system')
        exit(1)
    cloud_system_id = get_cloud_system_id(system_info)
    oauth_payload = create_payload(cloud_system_id)

    user_info = request_api(LOCAL_URL, f'/rest/v1/login/users/{CLOUD_USER}', 'GET', verify=False)

    if not is_cloud_user(user_info):
        print(CLOUD_USER + ' is not a cloud user.')
        exit(1)

    oath_response = request_api(CLOUD_URL, f'/cdb/oauth2/token', 'POST', json=oauth_payload)
    primary_token = get_token(oath_response)
    oauth_payload = create_payload()

    oath_response = request_api(CLOUD_URL, f'/cdb/oauth2/token', 'POST', json=oauth_payload)
    secondary_token = get_token(oath_response)

    token_info = request_api(LOCAL_URL, f'/rest/v1/login/sessions/{primary_token}', 'GET', verify=False)

    if is_expired(token_info):
        print('Expired token')
        exit(1)

    primary_token_header = create_header(primary_token)

    system_info = request_api(LOCAL_URL, f'/rest/v1/servers/*/info', 'GET',
                              headers=primary_token_header, verify=False)
    print_system_info(system_info)
    secondary_token_header = create_header(secondary_token)

    request_api(CLOUD_URL, f'/cdb/oauth2/token/{primary_token}', 'DELETE', headers=secondary_token_header)


if __name__ == '__main__':
    main()
