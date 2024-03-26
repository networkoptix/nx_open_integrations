import sys
import pathlib
sys.path += [f'{pathlib.Path(__file__).parent.resolve()}/../common']
import server_api as api
from pprint import pprint

CLOUD_USER = 'cloudaccount@networkoptix.com'  # cloud account
CLOUD_PASSWORD = 'cloudaccountpassword'  # cloud account password
CLOUD_SYSTEM_ID = 'your_own_cloud_system_id'  # (RFC 4122) More detail to locate your cloud system Id.
# https://support.networkoptix.com/hc/en-us/articles/360026419393-What-is-Cloud-Connect-

CLOUD_DOMAIN_NAME = 'nxvms.com'  # Cloud service domain name
CLOUD_URL = 'https://' + CLOUD_DOMAIN_NAME  # Cloud portal URL
RELAY_DOMAIN_NAME = '.relay.vmsproxy.com'  # Cloud relay entry

def main():
    # Obtain the token from the Cloud by OAuth2 for invoking API of a specific system
    oauth_payload = api.create_cloud_auth_payload(CLOUD_USER, CLOUD_PASSWORD, CLOUD_SYSTEM_ID)
    oath_response = api.request_api(
        CLOUD_URL,
        f'/cdb/oauth2/token',
        'POST',
        json=oauth_payload)
    system_token = api.get_token(oath_response)

    # Obtain the token from the Cloud by OAuth2 for invoking the cdb API
    oauth_payload = api.create_cloud_auth_payload(CLOUD_USER, CLOUD_PASSWORD)
    oath_response = api.request_api(
        CLOUD_URL,
        f'/cdb/oauth2/token',
        'POST',
        json=oauth_payload)
    if api.is_expired_cloud(oath_response):
        print('Token has token')
        exit(1)
    cloud_token = api.get_token(oath_response)

    cloud_system_url = f'https://{CLOUD_SYSTEM_ID}{RELAY_DOMAIN_NAME}'

    # Optinoal. Send a request via a loud relay to check if the token is valid on the System.
    token_info = api.request_api(
        cloud_system_url,
        f'/rest/v2/login/sessions/{system_token}',
        'GET',
        verify=False)
    if api.is_expired(token_info):
        print('Token has expired')
        exit(1)

    system_auth_header = api.create_auth_header(system_token)
    user_list = api.request_api(
        cloud_system_url,
        f'/rest/v2/users',
        'GET',
        headers=system_auth_header,
        verify=False,
        allow_redirects=False)
    api.print_user_list(user_list)

    # Delete the token for the System API
    cloud_auth_header = api.create_auth_header(cloud_token)    
    response = api.request_api(
        CLOUD_URL,
        f'/cdb/oauth2/token/{system_token}',
        'DELETE',
        headers=cloud_auth_header,
        verify=False)

    # Delete the token for the cdb API
    response = api.request_api(
        CLOUD_URL,
        f'/cdb/oauth2/token/{cloud_token}',
        'DELETE',
        headers=cloud_auth_header,
        verify=False)

if __name__ == '__main__':
    main()
