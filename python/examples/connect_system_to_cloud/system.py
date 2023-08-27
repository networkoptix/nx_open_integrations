#!/usr/bin/python3
import logging
import requests
import sys
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

logging.basicConfig(filename="connect_to_cloud.log",
                    filemode='a',
                    format='%(asctime)s %(levelname)s %(message)s',
                    datefmt="%Y-%m-%d %H:%M:%S",
                    level=logging.INFO)
logger = logging.getLogger(__name__)
#logger.setLevel(logging.INFO)

class system:

    def __init__(self, ip_address, port, system_name, local_admin_password, cloud_host, cloud_account, cloud_password):
        self.ip_address = ip_address
        self.port = port
        self.system_name = system_name
        self.local_admin_password = local_admin_password
        self.cloud_host = cloud_host
        self.cloud_account = cloud_account
        self.cloud_password = cloud_password

    def login(self, session, password):
        local_url = f"https://{self.ip_address}:{self.port}"
        credentials = {"username": "admin", "password": password, "setCookie": True}
        a = session.post(f"{local_url}/rest/v2/login/sessions", json=credentials, verify=False)
        return a

    def setup_system(self,session):
        pass

    def connect_to_cloud(self,session):
            local_url = f"https://{self.ip_address}:{self.port}"
            cloud_url = f"https://{self.cloud_host}"
            try:
                self.login(session, password=self.local_admin_password)
                cloud_credentials = {"name": self.system_name, "email": self.cloud_account, "password": self.cloud_password}
                res = session.post(f"{cloud_url}/api/systems/connect", json=cloud_credentials, verify=False)
                if res.status_code != 200:
                    print (res.json)
                    raise(requests.exceptions.HTTPError)
                else:
                    data = res.json()
                    cloud_info = {
                        "systemId": data.get("id"),
                        "authKey": data.get("authKey"),
                        "owner": data.get("ownerAccountEmail")
                    }
                    session.post(f"{local_url}/rest/v1/system/cloudBind", json=cloud_info)
                    session.delete(f"{local_url}/rest/v2/login/sessions")
                    
                    logger.info(f"{self.system_name} has been connected to {self.cloud_host} with {self.cloud_account}'s account.")
                    #print(f"{self.system_name} has been connected to {self.cloud_host} with {self.cloud_account}'s account.")
            except requests.exceptions.HTTPError as e:
                print(e)
                logger.error(f"Something went wrong. {self.system_name} will not be connecting to the cloud")
                #logger.warning(res.status_code)
                #logger.warning(res.content)
                #logger.error(e)
            
    def __del__(self):
        logging.debug( "System (" + self.system_name + ") Destructor called, instance removed.")
