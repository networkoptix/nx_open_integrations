import requests
requests.packages.urllib3.disable_warnings()
import json
from datetime import datetime
import time
from pprint import pprint
from requests.auth import HTTPDigestAuth
from argparse import ArgumentParser
from dataclasses import dataclass
import json
import os
import hashlib
import sys

@dataclass
class ServerCredentials:
    url: str
    username: str
    password: str

@dataclass
class CameraCredentials:
    url: str
    username: str
    password: str
    ip: str
    port: str
    is_stream: bool = False

def parse_arguments(args):
    sc = ServerCredentials("", "", "")
    server_creds, server_address = args.server_data.split("@")
    sc.url = f'https://{server_address}'
    sc.username, sc.password = server_creds.split(":")
   
    return sc, args.camera_name, args.video_file

def create_header(bearer_token):
    header = {"Authorization": f"Bearer {bearer_token}"}
    return header
   
def check_status(response, verbose):
    if response.status_code == requests.codes.ok:
        if verbose:
            print(f"Request successful\n{response.text}")
        return True
    print(f"{response.url} Request error {response.status_code}\n{response.text}")
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

def md5(filename):
    hash_md5 = hashlib.md5()
    with open(filename, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()

class FileUploader():
    def __init__(self, server_creds: ServerCredentials, verbose = True):
        self.camera_id = ""
        self.user_id = ""
        self.server_creds = server_creds
        self.verbose = verbose
        self.remote_filename = ""
        self.lock_token = ""
        self.chunk_size = 1024 * 1024
        self.filename = ""
        self.bearer_token = self._get_bearer_token()
        self.now = datetime.now()
           
    def create_virtual_camera(self, virtual_camera_name):    
        '''Create a Virtual Camera automatically using API'''
        
        virtual_camera_name_payload = {"name": virtual_camera_name}
        api_uri = '/api/virtualCamera/add'

        headers = create_header(self.bearer_token)
        headers['Content-Type'] = 'application/json'
        
        response = request_api(
            self.server_creds.url,
            api_uri,
            'POST',
            headers = headers,
            json=virtual_camera_name_payload,
            verify=False)
        if self.verbose:
            print("create_virtual_camera")
            print(response)
        if response["error"] == "0":
            self.camera_id = response["reply"]["id"]

    def _get_bearer_token(self):
        auth_payload = {
            'username': self.server_creds.username,
            'password': self.server_creds.password,
            'setCookie': False
        }
        session = request_api(
            self.server_creds.url, 
            f'/rest/v2/login/sessions', 
            'POST', 
            verify=False,
            json=auth_payload)
        return session['token']
           
    def _create_upload_job(self):
        now_str=self.now.strftime("%F_%H_%M") # makes filename unique, 
            #then (step 7) used to define start time of the chunk

        upload_job = {
            "size": f'{os.stat(self.filename).st_size}',
            "md5": md5(self.filename),
            "url": ""
        }

        headers = create_header(self.bearer_token)
        headers['Content-Type'] = 'application/json'
    
        # filename is needed in Step 5
        self.remote_filename = f'videofile{now_str}'
        api_uri = f"/api/downloads/{self.remote_filename}"

        response = request_api(
            self.server_creds.url,
            api_uri,
            "POST",
            json=upload_job,
            headers=headers,
            verify=False)
        if self.verbose:
            print("_create_upload_job")
            print(response)
                   
    def _upload_file(self):
        if len(self.remote_filename) == 0 : exit(1) # TODO
        chunk_index = 0
        headers = create_header(self.bearer_token)
        headers['Content-Type'] = 'application/octet-stream'

        with open(self.filename, "rb") as f:
            for chunk in iter(lambda: f.read(self.chunk_size), b""):
                api_uri = f'/api/downloads/{self.remote_filename}/chunks/{chunk_index}'
                response = request_api(
                    self.server_creds.url,
                    api_uri,
                    "PUT",
                    headers = headers,
                    data = chunk,
                    verify=False)
                chunk_index += 1
        if self.verbose:
            print("_upload_file")
            print(response)

    def _validate_upload(self):
        api_uri = f"/api/downloads/{self.remote_filename}/status"
        headers = create_header(self.bearer_token)
        headers['Content-Type'] = 'application/json'

        response = request_api(
            self.server_creds.url,
            api_uri,
            "GET",
            headers=headers,
            verify=False)
        if self.verbose:
            print("_validate_upload")
            print(response)
        if response["reply"]["status"] == 'downloaded':
            return
        else:
            print("Error: upload validation failed.")
            exit(1)
                  
    def _get_user_id(self):
        api_uri = f'/rest/v2/users' \
            f'?name={self.server_creds.username}'
        
        headers = create_header(self.bearer_token)
        headers['Content-Type'] = 'application/json'
        response = request_api(
            self.server_creds.url,
            api_uri,
            "GET",
            headers=headers,
            verify=False)
        self.user_id = response[0]['id']
        return self.user_id

    def _lock_camera(self):
        if self.verbose:
            print("_lock_camera")
        
        user_id = self._get_user_id()
        headers = create_header(self.bearer_token)
        headers['Content-Type'] = 'application/json'
        ttl = 300 # seconds
        api_uri = '/api/virtualCamera/lock'
        lock_camera = {
            "cameraId" : f"{self.camera_id}",
            "userId" : f"{user_id}",
            "ttl" : f"{ttl*1000}"
        }

        start_time = time.time()
        while True:
            response = request_api(
                self.server_creds.url,
                api_uri,
                "POST",
                json=lock_camera,
                headers=headers,
                verify=False)
            if self.verbose:
                print(response)
            if response['reply']['locked'] == True:
                self.lock_token = response["reply"]["token"]
                return
            time.sleep(1)
            if time.time() - start_time > ttl:
                print("Error: Exceeded timeout while locking camera. Locking failed.")
                exit(1)
          
    def _import_file(self):
        api_uri = f"/api/virtualCamera/consume"
        headers = create_header(self.bearer_token)
        headers['Content-Type'] = 'application/json'
        consume_file = {
            "cameraId": f"{self.camera_id}",
            "token": f"{self.lock_token}",
            "uploadId": f"{self.remote_filename}",
            "startTime": f"{(self.now.timestamp()*1000):.0f}" 
        } # startTime (timestamp, ms, UTC) sets the position of the file
        # being uploaded on timeline, now() is just a placeholder.

        response = request_api(
            self.server_creds.url,
            api_uri,
            "POST",
            headers=headers,
            json=consume_file,
            verify=False)
        if self.verbose:
            print("_import_file")
            print(response)
                 
    def _check_progress(self):
        if self.verbose:
            print("_check_progress")
        
        ttl = 300 # seconds
        api_uri = f"/api/virtualCamera/extend"
        headers = create_header(self.bearer_token)
        headers['Content-Type'] = 'application/json'
        check_progress = {
            "cameraId": f"{self.camera_id}",
            "token": f"{self.lock_token}",
            "userId": f"{self.user_id}",
            "ttl": f"{ttl*1000}"
        }
        start_time = time.time()

        while True:
            response = request_api(
                self.server_creds.url,
                api_uri,
                "POST",
                headers=headers,
                json=check_progress,
                verify=False)
            if self.verbose:
                print(response)
            # when upload is finished progress is 100
            if response["reply"]["progress"] == 100:
                return
            time.sleep(1)
            if time.time() - start_time > ttl:
                print("Error: Exceeded timeout while importing file. Import failed.")
                exit(1)
                
    def _release_camera(self):
        api_uri = '/api/virtualCamera/release'
        release_camera = {
            "cameraId": f"{self.camera_id}",
            "token": f"{self.lock_token}"
        }
        headers = create_header(self.bearer_token)
        headers['Content-Type'] = 'application/json'

        response = request_api(
            self.server_creds.url,
            api_uri,
            "POST",
            headers=headers,
            json=release_camera,
            verify=False)
        if self.verbose:
            print("_release_camera")
            print(response)
       
    def import_file_to_camera(self, filename):
        self.filename = filename

        # Step 1: Create a new upload job
        #
        self._create_upload_job()
        #
        # Step 2. Upload a file chunk by chunk
        # 
        self._upload_file()
        #
        # Step 3: Validate the file upload
        #
        self._validate_upload()
        #
        # Step 4: Lock the camera
        #    
        self._lock_camera()
        #
        # Step 5: Import the file
        #
        self._import_file()
        #
        # Step 6: Monitor importing progress
        #
        self._check_progress()
        #
        # Step 7: Release the camera
        #
        self._release_camera()

def main():
    parser = ArgumentParser()
    parser.add_argument("camera_name", 
        help = "A string containing a virtual camera name to be created")
    parser.add_argument("video_file",
        help = "A string containing the path to a video file")
    parser.add_argument("server_data",
        help="A string containing credentials and an address of a server in the format'\
            ' <username>:<password>@<address>:<port>")
    args = parser.parse_args()
    
    server_creds, camera_name, video_file = parse_arguments(args)

    fu = FileUploader(server_creds)
    fu.create_virtual_camera(camera_name)
    fu.import_file_to_camera(video_file)
    
if __name__ == '__main__':
    main()

