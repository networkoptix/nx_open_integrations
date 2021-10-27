import requests
from datetime import datetime
import json
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

USERNAME = 'admin'  # local account username
PASSWORD = 'pass123'  # local account password
SERVER_URL = 'https://localhost:7001'  # https://<server_ip>:<sever_port>
API_URI = '/ec2/dumpDatabase'  # API request URI
API_METHOD = 'GET'  # API request method


def check_status(request, verbose):
   if request.status_code == requests.codes.ok:
       if verbose:
           print("Request successful\n{0}".format(request.text))
       return True
   print(request.url + " Request error {0}\n{1}".format(request.status_code, request.text))
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
   system_backup = request_api(SERVER_URL, API_URI, API_METHOD, auth=requests.auth.HTTPDigestAuth(USERNAME, PASSWORD), verify=False)
   backup_time = datetime.now().strftime('%m-%d-%Y-%H-%M-%S')
   with open(f'systembackup_{backup_time}.bin', 'w+') as backup:
        json.dump(system_backup, backup)
        backup.seek(0)

if __name__ == '__main__':
   main()
