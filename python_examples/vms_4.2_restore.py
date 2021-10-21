import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

USERNAME = 'admin'  # local account username
PASSWORD = 'pass123'  # local account password
URL = 'https://localhost:7001'  # https://<server_ip>:<sever_port>
URI = '/ec2/restoreDatabase'  # API request URI
METHOD = 'POST'  # API request method


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
    with open(f'FILENAME.json', 'r') as recovery: #replace FILENAME with your backup file
        recovery_file = recovery.read()
    request_api(URL, URI, METHOD, auth=requests.auth.HTTPDigestAuth(USERNAME, PASSWORD), verify=False,
                                headers={'Content-type':'application/json'}, data=recovery_file)

if __name__ == '__main__':
   main()
