import requests
import time
from pprint import pprint
from requests.auth import HTTPBasicAuth, HTTPDigestAuth
from argparse import ArgumentParser
import json

search_timeout = 10
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

def main():

    parser = ArgumentParser()
    parser.add_argument("camera_data", 
        help="A string containing credentials and an address of a camera in the format <username>:<password>@<address>:<port>")
    parser.add_argument("server_data",
        help="A string containing credentials and an address of a server in the format <username>:<password>@<address>:<port>")
    args = parser.parse_args()

    camera_creds, camera_address = args.camera_data.split("@")
    camera_ip, camera_port = camera_address.split(":")
    camera_user, camera_password = camera_creds.split(":")

    server_creds, server_address = args.server_data.split("@")
    SERVER_URL = f'https://{server_address}'
    USERNAME, PASSWORD = server_creds.split(":")
    
    API_URI = f'/api/manualCamera/search?start_ip={camera_ip}&user={camera_user}&password={camera_password}'
    search_data = request_api(SERVER_URL,
                            API_URI, 
                            'GET', 
                            auth=HTTPDigestAuth(USERNAME, PASSWORD),
                            verify=False)
    # poll the search process status untill camera(s) found or timeout exeeded
    time_spent = 0
    while True:
        search_status = request_api(SERVER_URL,
                                f'/api/manualCamera/status?uuid={search_data["reply"]["processUuid"]}', 
                                'GET', 
                                auth=HTTPDigestAuth(USERNAME, PASSWORD),
                                verify=False)
        if search_status["reply"]["cameras"] != []:
            break
        time.sleep(1)
        time_spent += 1
        if time_spent > search_timeout:
            print("Timeout exeeded. No camera found.")
            exit(1)
            
    camera_data = dict(
         user = camera_user,
         password = camera_password,
         cameras = [
            dict(
                uniqueId = search_status["reply"]["cameras"][0]["uniqueId"],
                url = search_status["reply"]["cameras"][0]["url"],
                manufacturer = search_status["reply"]["cameras"][0]["manufacturer"],
            )
         ]
    )
    add_status = request_api(SERVER_URL,
                            f'/api/manualCamera/add', 
                            'POST', 
                            auth=HTTPDigestAuth(USERNAME, PASSWORD),
                            data = json.dumps(camera_data),
                            verify=False)                          
    
    stop_status = request_api(SERVER_URL,
                            f'/api/manualCamera/stop?uuid={search_data["reply"]["processUuid"]}', 
                            'GET', 
                            auth=HTTPDigestAuth(USERNAME, PASSWORD),
                            verify=False)                          

if __name__ == '__main__':
    main()
