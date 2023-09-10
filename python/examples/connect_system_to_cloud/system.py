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

class system:

    def __init__(self, ip_address, port, 
                 system_name, local_admin_password, 
                 cloud_host, cloud_account, cloud_password, connect_to_cloud, 
                 enable_auto_discovery):
        self.ip_address = ip_address
        self.port = port
        self.system_name = system_name
        self.local_admin_password = local_admin_password
        self.cloud_host = cloud_host
        self.cloud_account = cloud_account
        self.cloud_password = cloud_password
        self.connect_to_cloud = connect_to_cloud
        self.enable_auto_discovery = enable_auto_discovery

    def login(self, session, password="admin"):
        local_url = f"https://{self.ip_address}:{self.port}"
        credentials = {"username": "admin", "password": password, "setCookie": True}
        session.post(f"{local_url}/rest/v1/login/sessions", json=credentials, verify=False)

    def is_connect_to_cloud(self):
        if self.connect_to_cloud == "True":
            return True
        else:
            return False

    def connect_system_to_cloud(self,session):
        local_url = f"https://{self.ip_address}:{self.port}"
        cloud_url = f"https://{self.cloud_host}"
        try:
            self.login(session,self.local_admin_password)
            cloud_credentials = {
                "name": self.system_name, 
                "email": self.cloud_account, 
                "password": self.cloud_password
            }
            res = session.post(f"{cloud_url}/api/systems/connect", json=cloud_credentials, verify=False)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                data = res.json()
                cloud_info = {
                    "systemId": data.get("id"),
                    "authKey": data.get("authKey"),
                    "owner": data.get("ownerAccountEmail")
                }
                session.post(f"{local_url}/rest/v1/system/cloudBind", json=cloud_info)
                session.delete(f"{local_url}/rest/v1/login/sessions")               
                logger.info(
                    f"{self.system_name} has been connected to {self.cloud_host} with {self.cloud_account}'s account.")            
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. {self.system_name} will not be connecting to the cloud")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)

    def is_auto_discovery_disabled(self):
        if self.enable_auto_discovery == "True":
            return False
        else:
            return True

    def disable_auto_discovery_on_system(self,session):
        local_url = f"https://{self.ip_address}:{self.port}"
        try:
            self.login(session,self.local_admin_password)
            res = session.patch(f"{local_url}/rest/v1/system/settings", 
                json={"autoDiscoveryEnabled": False, "autoDiscoveryResponseEnabled": False})
            session.delete(f"{local_url}/rest/v1/login/sessions")
            logger.info(f"Auto discovery on {self.system_name} has been disabled")
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. Auto discovery on {self.system_name} remains enabled")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)

    def setup_system(self):
        local_url = f"https://{self.ip_address}:{self.port}"
        with requests.Session() as session:
            self.login(session)
            body = {
                "name": self.system_name,
                "settings": {},
                "local": {
                    "password": self.local_admin_password
                }
            }
            session.post(f"{local_url}/rest/v1/system/setup", json=body, verify=False)
            session.delete(f"{local_url}/rest/v1/login/sessions", verify=False)
            logger.info(f"{self.system_name} has been setup on {local_url}")
            
            if self.is_connect_to_cloud():
                self.connect_system_to_cloud(session)

            if self.is_auto_discovery_disabled():
                self.disable_auto_discovery_on_system(session)

    def __del__(self):
        logging.debug( "System (" + self.system_name + ") Destructor called, instance removed.")
