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
                 enable_auto_discovery,
                 allow_anonymous_statistics_report,
                 enable_camera_optimization):
        self.ip_address = ip_address
        self.port = port
        self.system_name = system_name
        self.local_admin_password = local_admin_password
        self.cloud_host = cloud_host
        self.cloud_account = cloud_account
        self.cloud_password = cloud_password
        self.connect_to_cloud = connect_to_cloud
        self.enable_auto_discovery = enable_auto_discovery
        self.allow_anonymous_statistics_report = allow_anonymous_statistics_report
        self.enable_camera_optimization = enable_camera_optimization

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
                return True           
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. {self.system_name} will not be connecting to the cloud")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

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
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                session.delete(f"{local_url}/rest/v1/login/sessions")
                logger.info(f"Auto discovery on {self.system_name} has been disabled")
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. Auto discovery on {self.system_name} remains enabled")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def is_camera_optimization_disabled(self):
        if self.enable_camera_optimization == "True":
            return False
        else:
            return True

    def disable_camera_optimization_on_system(self,session):
        local_url = f"https://{self.ip_address}:{self.port}"
        try:
            self.login(session,self.local_admin_password)
            res = session.patch(f"{local_url}/rest/v1/system/settings", 
                json={"cameraSettingsOptimization": False})
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                session.delete(f"{local_url}/rest/v1/login/sessions")
                logger.info(f"System optmization on {self.system_name} has been disabled")
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. System optmization on {self.system_name} remains enabled")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def is_anonymous_statistics_report_allowed(self):
        if self.allow_anonymous_statistics_report == "True":
            return False
        else:
            return True

    def disable_anonymous_statistics_report_on_system(self,session):
        local_url = f"https://{self.ip_address}:{self.port}"
        try:
            self.login(session,self.local_admin_password)
            res = session.patch(f"{local_url}/rest/v1/system/settings", 
                json={"statisticsAllowed": False})
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                session.delete(f"{local_url}/rest/v1/login/sessions")
                logger.info(f"Anonymous statistics on {self.system_name} has been disabled")
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. Anonymous statistics on {self.system_name} remains enabled")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def setup_system(self):
        local_url = f"https://{self.ip_address}:{self.port}"
        connect_to_cloud = False
        auto_discovery = True
        anonymous_statistics_report = True
        camera_optimization = True 
        

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
            
            #Connect to cloud operation
            if self.is_connect_to_cloud():
                if self.connect_system_to_cloud(session):
                    connect_to_cloud = True
            #Configure system settings opeartion(s)
            if self.is_auto_discovery_disabled():
                if self.disable_auto_discovery_on_system(session):
                    auto_discovery = False 
     
            if self.is_anonymous_statistics_report_allowed():
                if self.disable_anonymous_statistics_report_on_system(session):
                    anonymous_statistics_report = False 
            
            if self.is_camera_optimization_disabled():
                if self.disable_camera_optimization_on_system(session):
                    camera_optimization = False 
            # Could have more opeations below, ex: 
            # is_system_optmization_enabled(), 
            # is_data_collection_enabled(),
            # is_anonymous_data_collection_enabled() ... etc.
        
        system_setup_result = {"system_name":self.system_name, 
                               "connect_to_cloud":connect_to_cloud, 
                               "auto_discovery":auto_discovery,
                               "anonymous_statistics_report":anonymous_statistics_report,
                               "camera_optimization":camera_optimization}
        
        # Could have more parameter per needs/implementations, ex: 
        # system_setup_result = {"system_name":self.system_name, 
        #                        "connect_to_cloud":connect_to_cloud, 
        #                        "auto_discovery":auto_discovery,
        #                        "system_optimization:system_optimization",
        #                        "anonymous_data_collection":anonymous_data_collection}
        
        return system_setup_result


    def setup_system_test_output(self):
        connect_to_cloud = False
        auto_discovery = False
        #Connect to cloud operation
        if self.is_connect_to_cloud():
                #if self.connect_system_to_cloud(session):
            connect_to_cloud = True
        #Configure system settings opeartion(s)
        if self.is_auto_discovery_disabled():
            auto_discovery = True 
     
            # Could have more opeations below, ex: 
            # is_system_optmization_enabled(), 
            # is_data_collection_enabled(),
            # is_anonymous_data_collection_enabled() ... etc.
        
        system_setup_result = {"system_name":self.system_name, 
                               "connect_to_cloud":connect_to_cloud, 
                               "auto_discovery":auto_discovery,
                               "anonymous_statistics_report":anonymous_statistics_report,
                               "camera_optimization":camera_optimization}
        
        # Could have more parameter per needs/implementations, ex: 
        # system_setup_result = {"system_name":self.system_name, 
        #                        "connect_to_cloud":connect_to_cloud, 
        #                        "auto_discovery":auto_discovery,
        #                        "system_optimization:system_optimization",
        #                        "anonymous_data_collection":anonymous_data_collection}
        
        return system_setup_result
        

    def __del__(self):
        logging.debug( "System (" + self.system_name + ") Destructor called, instance removed.")
