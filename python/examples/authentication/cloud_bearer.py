import requests
from pprint import pprint
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

CLOUD_USER = 'cloudAccount@networkoptix.com'  # cloud account 
CLOUD_PASSWORD = 'cloudAccountPassword'  # cloud account password
CLOUD_SYSTEM_ID = "" # (RFC 4122) More detail to locate your cloud system Id.
                     # https://support.networkoptix.com/hc/en-us/articles/360026419393-What-is-Cloud-Connect-

CLOUD_DOMAIN_NAME = 'nxvms.com'  # Cloud service domain name
CLOUD_URL = 'https://' + CLOUD_DOMAIN_NAME # Cloud portal URL 
RELAY_DOMAIN_NAME = '.relay.vmsproxy.com' # Cloud relay entry


def check_status(response, verbose):
    if response.status_code == requests.codes.ok:
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


def create_payload(cloud_system_id=None):
    payload = {
        'grant_type': 'password', 'response_type': 'token', 'client_id': '3rdParty',
        'username': CLOUD_USER, 'password': CLOUD_PASSWORD
    }
    if cloud_system_id is not None:
        payload['scope'] = f'cloudSystemId={cloud_system_id}'
    return payload


def get_cloud_system_host_url(cloud_system_id):
    return cloud_system_id + RELAY_DOMAIN_NAME


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

    oauth_payload = create_payload(CLOUD_SYSTEM_ID)

    oath_response = request_api(CLOUD_URL, f'/cdb/oauth2/token', 'POST', json=oauth_payload)
    primary_token = get_token(oath_response)
    oauth_payload = create_payload()

    oath_response = request_api(CLOUD_URL, f'/cdb/oauth2/token', 'POST', json=oauth_payload)
    secondary_token = get_token(oath_response)

    #https://{cloudSystemId}.relay.vmsproxy.com
    cloud_system_url = "https://" + get_cloud_system_host_url(CLOUD_SYSTEM_ID) 
    
    token_info = request_api(cloud_system_url, f'/rest/v1/login/sessions/{primary_token}', 'GET', verify=False)
    if is_expired(token_info):
        print('Expired token')
        exit(1)

    primary_token_header = create_header(primary_token)

    system_info = request_api(cloud_system_url, f'/rest/v1/servers/*/info', 'GET',
                              headers=primary_token_header, verify=False)
    print_system_info(system_info)

    secondary_token_header = create_header(secondary_token)
    
    request_api(CLOUD_URL, f'/cdb/oauth2/token/{primary_token}', 'DELETE', headers=secondary_token_header)   


if __name__ == '__main__':
    main()
