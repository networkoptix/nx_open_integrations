import requests
import time
from pprint import pprint
from requests.auth import HTTPDigestAuth
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

class ServerCredentials:
    def __init__(self):
        self.url = ""
        self.username = ""
        self.password = ""

class CameraCredentials:
    def __init__(self):
        self.url = ""
        self.is_stream = False
        self.username = ""
        self.password = ""
        self.ip = ""
        self.port = ""

def parse_arguments(args):
    sc = ServerCredentials()
    server_creds, server_address = args.server_data.split("@")
    sc.url = f'https://{server_address}'
    sc.username, sc.password = server_creds.split(":")
    
    cc = CameraCredentials()
    camera_creds, camera_address = args.camera_data.split("@")
    if str(camera_address).startswith("rtsp://"):
        cc.is_stream = True
        cc.url = camera_address
    if not cc.is_stream:
        cc.ip, cc.port = camera_address.split(":")
    cc.username, cc.password = camera_creds.split(":")
    
    return sc, cc

def search_camera(server_creds: ServerCredentials, camera_creds : CameraCredentials):
    if camera_creds.is_stream:
        api_uri = f'/api/manualCamera/search?url={camera_creds.url}'
    else:
        api_uri = f'/api/manualCamera/search?start_ip={camera_creds.ip}&port={camera_creds.port}&user={camera_creds.username}&password={camera_creds.password}'
    search_data = request_api(server_creds.url,
                            api_uri, 
                            'GET', 
                            auth=HTTPDigestAuth(server_creds.username, server_creds.password),
                            verify=False)
    # poll the search process status until camera(s) found or timeout exceeded
    start_time = time.time()
    while True:
        search_status = request_api(server_creds.url,
                                f'/api/manualCamera/status?uuid={search_data["reply"]["processUuid"]}', 
                                'GET', 
                                auth=HTTPDigestAuth(server_creds.username, server_creds.password),
                                verify=False)
        if search_status["reply"]["cameras"] != []:
            return search_status, search_data
        time.sleep(1)
        if time.time() - start_time > search_timeout:
            raise RuntimeError('Timeout exceeded. No camera found.')
          
def main():
    
    parser = ArgumentParser()
    parser.add_argument("camera_data", 
        help="A string containing credentials and an address of a camera in the format <username>:<password>@<address>:<port> or <username>:<password>@<RTSP url>")
    parser.add_argument("server_data",
        help="A string containing credentials and an address of a server in the format <username>:<password>@<address>:<port>")
    args = parser.parse_args()
    
    server_creds, camera_creds = parse_arguments(args)
    
    try:
        serach_status, serach_data = search_camera(server_creds, camera_creds)
    except Exception as ex:
        print(ex.args)
        exit(1)

    
    if camera_creds.is_stream:
        stream_data = dict(
            user = camera_user,
            password = camera_password,
            uniqueId0=search_status["reply"]["cameras"][0]["uniqueId"],
            url0=search_status["reply"]["cameras"][0]["url"],
            manufacturer0=search_status["reply"]["cameras"][0]["manufacturer"]
        )
        add_status = request_api(server_url,
                                f'/api/manualCamera/add',
                                'GET',
                                auth=HTTPDigestAuth(username, password),
                                params = stream_data,
                                verify=False)
    else: # adding a camera
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
        add_status = request_api(server_url,
                            f'/api/manualCamera/add', 
                            'POST', 
                            auth=HTTPDigestAuth(username, password),
                            data = json.dumps(camera_data),
                            verify=False)                          
    stop_status = request_api(server_url,
                            f'/api/manualCamera/stop?uuid={search_data["reply"]["processUuid"]}', 
                            'GET', 
                            auth=HTTPDigestAuth(username, password),
                            verify=False)
if __name__ == '__main__':
    main()
