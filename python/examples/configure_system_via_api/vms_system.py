#!/usr/bin/python3
import logging
import requests
import sys
import urllib3
import json
import configparser
from dataclasses import dataclass, asdict
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


logging.basicConfig(filename="configure_system.log",
                    filemode='a',
                    format='%(asctime)s %(levelname)s %(message)s',
                    datefmt="%Y-%m-%d %H:%M:%S",
                    level=logging.INFO)
logger = logging.getLogger(__name__)
http_timeout = 5

@dataclass
class VmsSystemSettings:
    cloudSystemID: str
    autoDiscoveryEnabled: str
    autoDiscoveryResponseEnabled: str
    cameraSettingsOptimization: str
    statisticsAllowed: str


class VmsSystem:

    def __init__(self, configuration_file):
        try:
            system_configurations = configparser.ConfigParser()
            system_configurations.read(configuration_file)
            self.ip_address = system_configurations["server"]["ip_address"]
            self.port = system_configurations["server"]["port"]
            self.local_url = f"https://{self.ip_address}:{self.port}"
            self.system_name = system_configurations["server"]["system_name"]
            self.local_admin_password = system_configurations["server"]["local_admin_password"]
            self.cloud_host = system_configurations["cloud"]["cloud_host"]
            self.cloud_url = f"https://{self.cloud_host}"
            self.cloud_account = system_configurations["cloud"]["cloud_account"]
            self.cloud_password = system_configurations["cloud"]["cloud_password"]
            self.connect_to_cloud = system_configurations["system_settings"]["connect_to_cloud"]
            self.enable_auto_discovery = system_configurations["system_settings"]["enable_auto_discovery"]
            self.allow_anonymous_statistics_report = system_configurations["system_settings"]["allow_anonymous_statistics_report"]
            self.enable_camera_optimization = system_configurations["system_settings"]["enable_camera_optimization"]
            self.system_settings = VmsSystemSettings(
                cloudSystemID="",
                autoDiscoveryEnabled="False",
                autoDiscoveryResponseEnabled="False",
                cameraSettingsOptimization="False",
                statisticsAllowed="False")
            self.session = requests.Session()
        except Exception as e:
            logging.error(e)
            print(f'Openration Failed : The system object initialization is not successfully done.')

    def login(self, password="admin"):
        credentials = {"username": "admin", "password": password, "setCookie": True}
        self.session.post(f"{self.local_url}/rest/v2/login/sessions", json=credentials, timeout=http_timeout, verify=False)
        
    def get_current_system_settings(self,current_settings):
        try:
            self.login(self.local_admin_password)
            res = self.session.get(f"{self.local_url}/rest/v2/system/settings") 
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                settings = res.json()
                self.session.delete(f"{self.local_url}/rest/v2/login/sessions/current", verify=False)               
                logger.info(f"{self.system_name} : Current Settings = {settings}")
                for setting in settings:
                    if setting in current_settings.keys():
                        current_settings[setting] = settings.get(setting)
        except requests.exceptions.HTTPError as e:
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            print(f"Something went wrong. Can't get the system settings of {self.system_name}")
            current_settings = {
                "cloudSystemID":"Unknown",
                "autoDiscoveryEnabled":"Unknown",
                "autoDiscoveryResponseEnabled":"Unknown",
                "cameraSettingsOptimization":"Unknown",
                "statisticsAllowed":"Unknown"}
        return current_settings

    ######
    def is_user_need_to_connect_to_cloud(self):
        if self.connect_to_cloud == "True":
            return True
        else:
            return False

    def connect_system_to_cloud(self):
        try:
            self.login(self.local_admin_password)
            cloud_credentials = {
                "name": self.system_name, 
                "email": self.cloud_account, 
                "password": self.cloud_password
            }
            res = self.session.post(f"{self.cloud_url}/api/systems/connect", json=cloud_credentials, verify=False)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                data = res.json()
                cloud_info = {
                    "systemId": data.get("id"),
                    "authKey": data.get("authKey"),
                    "owner": data.get("ownerAccountEmail")
                }
                self.session.post(f"{self.local_url}/rest/v2/system/cloudBind", json=cloud_info, verify=False)
                self.session.delete(f"{self.local_url}/rest/v2/login/sessions/current", verify=False)              
                logger.info(f"{self.system_name} : Connected to {self.cloud_host} bind to {self.cloud_account}'s account")
                logger.info(f"{self.system_name} : Cloud System Id = {data.get('id')}")
                return True           
        except requests.exceptions.HTTPError as e:
            logger.error(f"{self.system_name} : Something went wrong, will not be connecting to the cloud")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def detach_system_from_cloud(self):
        try:
            self.login(self.local_admin_password)
            detach_cloud_info = {
                "password": self.local_admin_password,
                "userAgent": "3rd_party_tool"
            }
            self.session.post(f"{self.local_url}/rest/v2/system/cloudUnbind", json=detach_cloud_info,verify=False)
            self.session.delete(f"{self.local_url}/rest/v2/login/sessions/current", verify=False)               
            logger.info( f"{self.system_name}: Disconnect from {self.cloud_host} , detach from {self.cloud_account}'s account.")
            return True           
        except requests.exceptions.HTTPError as e:
            logger.error(f"{self.system_name}: Something went wrong, will be still connecting to the cloud")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def setup_connect_to_cloud(self, current_cloud_state):
        logger.info(f"{self.system_name} : Previous Cloud connected state = {current_cloud_state}") #Cloud System ID or None
        if current_cloud_state == "": 
            if self.is_user_need_to_connect_to_cloud():            
                if self.connect_system_to_cloud():
                    current_cloud_state = "CONNECTED"
            else:
                current_cloud_state = "DISCONNECTED(LOCAL)"                    
        elif current_cloud_state == "UNKNOWN":
            logger.warning(f"{self.system_name} has unknown state for Cloud connect, state has not changed.")
        else:
            if self.is_user_need_to_connect_to_cloud():
                current_cloud_state = "CONNECTED"
            else:
                if self.detach_system_from_cloud():
                    current_cloud_state = "DISCONNECTED(LOCAL)"  
                else:
                    current_cloud_state = "CONNECTED"
                    logger.warning(f"{self.system_name} has unknown state for cloud connection, state remains no changed - Connected)")
        
        logger.info(f"{self.system_name} : Cloud connect has been completed.")
        logger.info(f"{self.system_name} : Current Cloud connected state = {current_cloud_state}") 
        
        return current_cloud_state

    ######
    def is_user_need_to_enable_auto_discovery(self):
        if self.enable_auto_discovery == "True":
            return True
        else:
            return False

    def configure_auto_discovery(self,state):
        logger.debug(f"{self.system_name} : configure_auto_discovery to {state}")
        try:
            self.login(self.local_admin_password)
            res = self.session.patch(f"{self.local_url}/rest/v2/system/settings", 
                json={"autoDiscoveryEnabled": state, "autoDiscoveryResponseEnabled": state},
                verify=False)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                self.session.delete(f"{self.local_url}/rest/v2/login/sessions/current",verify=False)
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. Auto discovery on {self.system_name} remains same state")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def setup_auto_discovery(self,current_auto_discover_state):
        logger.info(f"{self.system_name} : Auto discovery previous state = {current_auto_discover_state}")
        if current_auto_discover_state == "UNKNOWN":
            logger.warning(
                f"{self.system_name} : Auto discovery current state = {current_auto_discover_state}")
        else:
            if self.is_user_need_to_enable_auto_discovery():
                if self.configure_auto_discovery(True):
                    current_auto_discover_state = "ENABLED"
                    logger.debug(
                        f"{self.system_name} : Auto discovery state has been changed. Current state = {current_auto_discover_state}")
                else:
                    print(f"{self.system_name} : Operation failed. Auto discovery state has not been changed. Current state = {current_auto_discover_state} )")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Auto discovery state has not been changed. Current state = {current_auto_discover_state} )")
            else:
                if self.configure_auto_discovery(False):
                    current_auto_discover_state = "DISABLED"
                    logger.debug(f"{self.system_name} : Auto discovery has been disabled")
                else:
                    print(f"{self.system_name} : Operation failed. Auto discovery state has not been changed. Current state = {current_auto_discover_state} )")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Auto discovery state has not been changed. Current state = {current_auto_discover_state} )")

        logger.info(f"{self.system_name} : Auto discovery configuration has been completed.")
        logger.info(f"{self.system_name} : Current Auto discovery state = {current_auto_discover_state}")
        return current_auto_discover_state           
    
    ######
    def is_user_need_to_enable_camera_optimization(self):
        if self.enable_camera_optimization == "True":
            return True
        else:
            return False

    def configure_camera_optimization(self,state):
        logger.debug(f"{self.system_name} : configure_camera_optimization to {state}")
        try:
            self.login(self.local_admin_password)
            res = self.session.patch(f"{self.local_url}/rest/v2/system/settings", 
                json={"cameraSettingsOptimization": state},
                verify=False)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                self.session.delete(f"{self.local_url}/rest/v2/login/sessions/current",verify=False)
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. System optmization on {self.system_name} remains same status")
            logger.debug(res.status_code)
            logger.debug(res.content)
            logger.error(e)
            return False

    def setup_camera_optimization(self,current_camera_optimization_state):
        logger.info(f"{self.system_name} : Camera optimization previous state = {current_camera_optimization_state}")
        if current_camera_optimization_state == "UNKNOWN":
            logger.warning(
                f"{self.system_name} :  Camera Optimoptimizationization current state = {current_camera_optimization_state} )")
        else:
            if self.is_user_need_to_enable_camera_optimization():
                if self.configure_camera_optimization(True):
                    current_camera_optimization_state = "ENABLED"
                    logger.debug(
                        f"{self.system_name} :  Camera optimization state has been changed. Current state = {current_camera_optimization_state}")
                else:
                    print(f"{self.system_name} : Operation failed. Camera optimization state has not been changed. Current state = {current_camera_optimization_state}")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Camera optimization state has not been changed. Current state = {current_camera_optimization_state}")
            else:
                if self.configure_camera_optimization(False):
                    current_camera_optimization_state = "DISABLED"
                    logger.debug(
                        f"{self.system_name} : Camera optimization state has been changed. Current state = {current_camera_optimization_state}")
                else:
                    print(f"{self.system_name} : Operation failed. Camera optimization state has not been changed. Current state = {current_camera_optimization_state} )")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Camera optimization state has not been changed. Current state = {current_camera_optimization_state} )")

        logger.info(f"{self.system_name} : Camera optimization configuration has been completed.")
        logger.info(f"{self.system_name} : Current Camera optimization state = {current_camera_optimization_state}")
        return current_camera_optimization_state
           
    ######
    def is_user_need_to_enable_anonymous_statistics_report(self):
        if self.allow_anonymous_statistics_report == "True":
            return True
        else:
            return False

    def configure_anonymous_statistics_report(self,state):
        logger.debug(f"{self.system_name} : configure_anonymous_statistics_report to {state}")
        try:
            self.login(self.local_admin_password)
            res = self.session.patch(f"{self.local_url}/rest/v2/system/settings", 
                json={"statisticsAllowed": state},
                verify=False)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                self.session.delete(f"{self.local_url}/rest/v2/login/sessions/current",verify=False)
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. Anonymous statistics report on {self.system_name} remains same state")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def setup_anonymous_statistics_report(self,current_anonymous_statistics_report_state):
        logger.info(
            f"{self.system_name} : Anonymous statistics report previous state = {current_anonymous_statistics_report_state}")
        if current_anonymous_statistics_report_state == "Unknown":
            logger.warning(
                f"{self.system_name} :  Anonymous statistics report current state = {current_anonymous_statistics_report_state} )")
        else:
            if self.is_user_need_to_enable_anonymous_statistics_report():
                if self.configure_anonymous_statistics_report(True):
                    current_anonymous_statistics_report_state = "ENABLED"
                    logger.debug(
                        f"{self.system_name} :  Anonymous statistics report state has been changed. Current state = {current_anonymous_statistics_report_state}")
                else:
                    print(f"{self.system_name} : Operation failed. Anonymous statistics report state has not been changed. Current state = {current_anonymous_statistics_report_state}")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Anonymous statistics report state has not been changed. Current state = {current_anonymous_statistics_report_state}")
            else:
                if self.configure_anonymous_statistics_report(False):
                    current_anonymous_statistics_report_state = "DISABLED"
                    logger.debug(
                        f"{self.system_name} : Anonymous statistics report state has been changed. Current state = {current_anonymous_statistics_report_state}")
                else:
                    print(f"{self.system_name} : Operation failed. Anonymous statistics report state has not been changed. Current state = {current_anonymous_statistics_report_state}")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Anonymous Statistics Report state has not been changed. Current state = {current_anonymous_statistics_report_state}")
               
        logger.info(f"{self.system_name} : Anonymous statistics report configuration has been completed.")
        logger.info(f"{self.system_name} : Current Anonymous statistics report state = {current_anonymous_statistics_report_state}")
        return current_anonymous_statistics_report_state

    ######   
    def setup_system(self):   
        connect_to_cloud = False
        auto_discovery = True
        anonymous_statistics_report = True
        camera_optimization = True 
        system_settings_dict = asdict(self.system_settings)
        logging.info(f"{self.system_name} : ==============")
        with requests.Session() as session:
            self.login()
            body = {
                "name": self.system_name,
                "settings": {},
                "local": {
                    "password": self.local_admin_password
                }
            }
            self.session.post(f"{self.local_url}/rest/v2/system/setup", json=body, verify=False)
            #Get Current system settings
            current_system_settings = self.get_current_system_settings(system_settings_dict)
            self.session.delete(f"{self.local_url}/rest/v2/login/sessions/current", verify=False)
            #Connect to cloud operation
            connect_to_cloud = self.setup_connect_to_cloud(current_system_settings["cloudSystemID"])
            #Auto_discover
            auto_discovery = self.setup_auto_discovery(current_system_settings["autoDiscoveryEnabled"])
            #Camera optimization
            camera_optimization = self.setup_camera_optimization(current_system_settings["cameraSettingsOptimization"])
            #Configure Anonymous statistics report
            anonymous_statistics_report = self.setup_anonymous_statistics_report(current_system_settings["statisticsAllowed"])
            system_setup_result = {
                "system_name":self.system_name, 
                "connect_to_cloud":connect_to_cloud, 
                "auto_discovery":auto_discovery,
                "anonymous_statistics_report":anonymous_statistics_report,
                "camera_optimization":camera_optimization
            }
            return system_setup_result