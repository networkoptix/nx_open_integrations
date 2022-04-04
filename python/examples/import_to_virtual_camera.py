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
    def __init__(self, server_creds: ServerCredentials, verbose = False):
        self.camera_id = ""
        self.user_id = ""
        self.server_creds = server_creds
        self.virtual_camera_name = ""
        self.verbose = verbose
        self.remote_filename = ""
        self.lock_token = ""
        self.chunk_size = 1024 * 1024
        self.filename = ""

    def create_virtual_camera(self, virtual_camera_name):    
        '''Create a Virtual Camera automatically using API'''
        
        self.virtual_camera_name = virtual_camera_name
        api_uri = f'/api/wearableCamera/add' \
                  f'?name={virtual_camera_name}' 
        
        response = request_api(
            self.server_creds.url,
            api_uri,
            'POST',
            auth=HTTPDigestAuth(self.server_creds.username, self.server_creds.password),
            headers = {'Content-Type': 'application/json'},
            verify=False)
        if self.verbose:
            print("create_virtual_camera")
            print(response)
        if response["error"] == "0":
            self.camera_id = response["reply"]["id"]
           
    def _create_upload_job(self):
        self.now = datetime.now()
        now_str=self.now.strftime("%F_%H_%M") # makes filename unique, then (step 7) used to define start time of the chunk
    
        # filename is needed in Step 5
        self.remote_filename= f'videofile{now_str}'
        api_uri = f"/api/downloads/{self.remote_filename}"\
                  f"?size={os.stat(self.filename).st_size}"\
                  f"&chunkSize={self.chunk_size}"\
                  f"&md5={md5(self.filename)}"\
                  f"&ttl=86400000"\
                  f"&upload=true"

        response = request_api(
            self.server_creds.url,
            api_uri,
            "POST",
            auth=HTTPDigestAuth(self.server_creds.username, self.server_creds.password),
            headers = {'Content-Type': 'application/json'},
            verify=False)
        if self.verbose:
            print("_create_upload_job")
            print(response)
                   
    def _upload_file(self):
        now_str=self.now.strftime("%F_%H_%M")
        chunk_index = 0
        with open(self.filename, "rb") as f:
            for chunk in iter(lambda: f.read(self.chunk_size), b""):
                api_uri =   f'/api/downloads/videofile{now_str}/chunks/{chunk_index}'
                response = request_api(
                    self.server_creds.url,
                    api_uri,
                    "PUT",
                    auth=HTTPDigestAuth(self.server_creds.username, self.server_creds.password),
                    headers = {'Content-Type': 'application/octet-stream'},
                    data = chunk,
                    verify=False)
                chunk_index += 1
        if self.verbose:
            print("_upload_file")
            print(response)

    def _validate_upload(self):
        now_str=self.now.strftime("%F_%H_%M")
        api_uri =   f"/api/downloads/videofile{now_str}/status"
        response = request_api(
            self.server_creds.url,
            api_uri,
            "GET",
            auth=HTTPDigestAuth(self.server_creds.username, self.server_creds.password),
            verify=False)
        if self.verbose:
            print("_validate_upload")
            print(response)
        if response["reply"]["status"] == 'downloaded':
            return
        else:
            raise RuntimeError('File upload failed.')
                  
    def _get_user_id(self):
        api_uri = f'/ec2/getUsers'
        response = request_api(
            self.server_creds.url,
            api_uri,
            "GET",
            auth=HTTPDigestAuth(self.server_creds.username, self.server_creds.password),
            verify=False)
        for user_data in response:
            if user_data["name"] == self.server_creds.username:
                self.user_id = user_data["id"]
                return self.user_id

    def _lock_camera(self):
        if self.verbose:
            print("_lock_camera")
        
        # POST /api/wearableCamera/lock — locks Virtual Camera.
        # Parameters:
        #   cameraId — id of the camera
        #   userId — id of the user performing the lock
        #   ttl — lock timeout in ms
        user_id = self._get_user_id()
        ttl = 300
        api_uri = f'/api/wearableCamera/lock' \
                  f'?cameraId={self.camera_id}' \
                  f'&userId={user_id}' \
                  f'&ttl={ttl*1000}'

        start_time = time.time()
        while True:
            response = request_api(
                self.server_creds.url,
                api_uri,
                "POST",
                auth=HTTPDigestAuth(self.server_creds.username, self.server_creds.password),
                verify=False)
            if self.verbose:
                print(response)
            if response['reply']['locked'] == True:
                self.lock_token = response["reply"]["token"]
                return
            time.sleep(1)
            if time.time() - start_time > ttl:
                raise RuntimeError("Timeout exceeded. Locking the camera failed.")
          
    def _import_file(self):
        # POST /api/wearableCamera/consume
        # Parameters:
        #   cameraId — id of the camera
        #   token — token acquired when this camera was first locked
        #   uploadId — name of the previously uploaded file
        #   startTime — starting time of the file in msecs since epoch
        api_uri = f'/api/wearableCamera/consume' \
                  f'?cameraId={self.camera_id}' \
                  f'&token={self.lock_token}' \
                  f'&uploadId={self.remote_filename}' \
                  f'&startTime=0'
        response = request_api(
            self.server_creds.url,
            api_uri,
            "POST",
            auth=HTTPDigestAuth(self.server_creds.username, self.server_creds.password),
            verify=False)
        if self.verbose:
            print("_import_file")
            print(response)
                 
    def _check_progress(self):
        if self.verbose:
            print("_check_progress")
        
        # POST /api/wearableCamera/extend — extends Virtual Camera lock
        # Parameters:
        #   cameraId — id of the camera
        #   userId — id of the user performing the lock
        #   ttl — lock timeout in ms
        #   token — token acquired when this camera was first locked
        ttl = 300
        api_uri = f"/api/wearableCamera/extend" \
                  f"?cameraId={self.camera_id}" \
                  f'&userId={self.user_id}' \
                  f'&ttl={ttl*1000}' \
                  f'&token={self.lock_token}'
        start_time = time.time()
        while True:
            response = request_api(
                self.server_creds.url,
                api_uri,
                "POST",
                auth=HTTPDigestAuth(self.server_creds.username, self.server_creds.password),
                verify=False)
            if self.verbose:
                print(response)
            # when upload is finished progress is 0
            if response["reply"]["progress"] == 0:
                return
            time.sleep(1)
            if time.time() - start_time > ttl:
                raise RuntimeError('Timeout exceeded. File import failed')
                
    def _release_camera(self):
        api_uri = f"/api/wearableCamera/release" \
                  f"?cameraId={self.camera_id}" \
                  f'&token={self.lock_token}'
        response = request_api(
            self.server_creds.url,
            api_uri,
            "POST",
            auth=HTTPDigestAuth(self.server_creds.username, self.server_creds.password),
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

    fd = FileUploader(server_creds)
    fd.create_virtual_camera(camera_name)
    fd.import_file_to_camera(video_file)
    
if __name__ == '__main__':
    main()

