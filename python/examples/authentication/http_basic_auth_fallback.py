import sys
import pathlib
sys.path += [f'{pathlib.Path(__file__).parent.resolve()}/../common']
import server_api as api

USERNAME = 'admin'  # local account username
PASSWORD = 'Admin12345'  # local account password

CLOUD_SYSTEM_ID = 'your_cloud_system_id'  # (RFC 4122) More detail to locate your cloud system Id.
RELAY_DOMAIN_NAME = 'relay.vmsproxy.com'  # Cloud relay entry
# https://support.networkoptix.com/hc/en-us/articles/360026419393-What-is-Cloud-Connect-

SERVER_IP = "127.0.0.1"
SERVER_PORT = "7001"

SERVER_URL = f'https://{CLOUD_SYSTEM_ID}.{RELAY_DOMAIN_NAME}' # Also support direct IP:port
#SERVER_URL = f'https://{SERVER_IP}:{SERVER_PORT}'

def main():

    auth_http_basic = api.create_auth_for_http_basic_fallback(USERNAME, PASSWORD, SERVER_URL)
    user_info = api.request_api(
        SERVER_URL,
        '/rest/v3/users',
        "GET",
        auth=auth_http_basic, # {username, password} = {"-", "local_media_server_session_token"}
        allow_redirects=False,
        verify=False)
    api.print_user_list(user_info)
    

if __name__ == '__main__':
    main()
