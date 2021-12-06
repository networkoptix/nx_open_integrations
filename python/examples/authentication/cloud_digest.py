import requests
from pprint import pprint
from requests.auth import HTTPBasicAuth, HTTPDigestAuth

CLOUD_USER = 'user@gmail.com'  # cloud account email
CLOUD_PASSWORD = 'pass123'  # cloud account password
CLOUD_URL = 'https://nxvms.com'  # cloud service URL
API_URI = '/api/moduleInformation?allModules=true'  # API request URI
API_METHOD = 'GET'  # API request method


def check_status(response, verbose):
    if response.status_code == requests.codes.ok:
        if verbose:
            print("Request successful\n{0}".format(response.text))
        return True
    print(response.url + " Request error {0}\n{1}".format(response.status_code, response.text))
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


def get_system_id(system_info):
    if system_info['systems'][0]['id'] == '' or None:
        print('Could not find a system ID')
        exit(1)
    else:
        return system_info['systems'][0]['id']


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
    cloud_system_info = request_api(CLOUD_URL, '/cdb/system/get', 'GET',
                                    auth=HTTPDigestAuth(CLOUD_USER, CLOUD_PASSWORD), verify=False)
    print(cloud_system_info)
    system_id = get_system_id(cloud_system_info)
    system_info = request_api(f'https://{system_id}.relay.vmsproxy.com', API_URI, API_METHOD,
                              auth=HTTPDigestAuth(CLOUD_USER, CLOUD_PASSWORD), verify=False)
    print_system_info(system_info)


if __name__ == '__main__':
    main()
