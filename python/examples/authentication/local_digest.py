from requests.auth import HTTPDigestAuth
import sys
import pathlib
sys.path += [f'{pathlib.Path(__file__).parent.resolve()}/../common']
import server_api as api

USERNAME = 'admin'  # local account username
PASSWORD = 'pass123'  # local account password
SERVER_URL = 'https://localhost:7001'  # https://<server_ip>:<sever_port>


def main():
    system_info = api.request_api(
        SERVER_URL,
        '/api/moduleInformation?allModules=true',
        "GET",
        auth=HTTPDigestAuth(USERNAME, PASSWORD),
        verify=False)
    api.print_system_info(system_info)

if __name__ == '__main__':
    main()
