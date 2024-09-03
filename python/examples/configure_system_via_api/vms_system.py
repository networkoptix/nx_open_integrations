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

@dataclass
class VmsSystemSettings:
    customization: str
    systemName: str
    cloudSystemID: str
    cloud_host: str
    autoDiscoveryEnabled: str
    autoDiscoveryResponseEnabled: str
    cameraSettingsOptimization: str
    statisticsAllowed: str


class VmsSystem:
    def __init__(self, configuration_file):
        try:
            system_configuration = configparser.ConfigParser()
            system_configuration.read(configuration_file)
            with open('cloud_hosts.json', 'r') as file:
                product_info = json.load(file)
            self.ip_address = system_configuration["server"]["ip_address"]
            self.port = system_configuration["server"]["port"]
            self.system_name = system_configuration["server"]["system_name"]
            self.product_name = system_configuration["system_settings"]["product"]
            self.local_admin_password = system_configuration["server"]["local_admin_password"]
            self.customization = self.__get_customization(product_info["data"])
            self.local_url = f"https://{self.ip_address}:{self.port}"
            self.cloud_host = self.__get_cloud_host(product_info["data"])
            self.cloud_url = f"https://{self.cloud_host}"
            self.cloud_account = system_configuration["cloud"]["cloud_account"]
            self.cloud_password = system_configuration["cloud"]["cloud_password"]
            self.connect_to_cloud = system_configuration["system_settings"]["connect_to_cloud"]
            self.enable_auto_discovery = system_configuration["system_settings"]["enable_auto_discovery"]
            self.allow_anonymous_statistics_report = system_configuration["system_settings"]["allow_anonymous_statistics_report"]
            self.enable_camera_optimization = system_configuration["system_settings"]["enable_camera_optimization"]
            self.system_settings = VmsSystemSettings(
                customization = self.customization,
                systemName=self.system_name,
                cloudSystemID="",
                cloud_host = self.cloud_host,
                autoDiscoveryEnabled="False",
                autoDiscoveryResponseEnabled="False",
                cameraSettingsOptimization="False",
                statisticsAllowed="False")
            self.session = requests.Session()
            self.http_timeout = 5
        except Exception as e:
            logging.error(e)
            print(f'[ERROR] VmsSystem object initialization was not successful.')
    
    def __get_cloud_host(self, products):
        cloud_host = ""
        for product in products:
            for name,info in product.items():
                if self.product_name == name:
                    cloud_host = product[name]["cloud_host"]
                    break
        return cloud_host
    
    def __get_customization(self, products):
        customization = ""
        for product in products:
            for name,info in product.items():
                if self.product_name == name:
                    customization = product[name]["customization"]
                    break
        return customization

    def set_http_timeout(self, timeout_in_seconds):
        self.http_timeout = timeout_in_seconds

    def __get_access_token_via_ms(self, username, password):
        credentials = {"username": username, "password": password, "setCookie": True}
        res = self.session.post(f"{self.local_url}/rest/v2/login/sessions", json=credentials, timeout=self.http_timeout, verify=False, allow_redirects=True)
        access_token = res.json().get("token")
        return access_token
    
    def __get_access_token_via_cdb(self, username, password):
        cloud_credentials = {
            "username": username, 
            "password": password,
            'grant_type': 'password',
            'response_type': 'token',
            'client_id': '3rd_party_tool'
        }
        res = self.session.post(f"{self.cloud_url}/cdb/oauth2/token", json=cloud_credentials, timeout=self.http_timeout, verify=False)
        access_token = res.json().get("access_token")
        return access_token
        
    def __get_authentication_header(self, bearer_token):
        auth_header = {"Authorization": f"Bearer {bearer_token}"}
        return auth_header
    
    def login(self, username, password="admin", schema=""):
        token = ""
        if schema == "cloud":
            token = self.__get_access_token_via_cdb(username, password)
        else:
            token = self.__get_access_token_via_ms(username, password)
        
        return self.__get_authentication_header(token)

    def get_current_system_settings(self,current_settings):
        try:
            res = self.session.get(f"{self.local_url}/rest/v2/system/settings", timeout=self.http_timeout, verify=False, allow_redirects=True) 
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                settings = res.json()
                logger.info(f"{self.system_name} : Current Settings = {settings}")
                for setting in settings:
                    if setting in current_settings.keys():
                        current_settings[setting] = settings.get(setting)
        except requests.exceptions.HTTPError as e:
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            print(f"[ERROR] Can't get the current system settings.")
            current_settings = {
                "systemName":"UNKNOWN",
                "cloudSystemID":"UNKNOWN",
                "autoDiscoveryEnabled": "UNKNOWN",
                "autoDiscoveryResponseEnabled":"UNKNOWN",
                "cameraSettingsOptimization":"UNKNOWN",
                "statisticsAllowed":"UNKNOWN"}
        return current_settings

    ######
    def __need_to_connect_to_cloud(self):
        if self.connect_to_cloud == "True":
            return True
        else:
            return False

    def _connect_system_to_cloud(self):
        try:
            login_auth_header = self.login(self.cloud_account, self.cloud_password,"cloud")
            sys_payload = {
                "name": self.system_name, 
                "customization": self.customization
                #"organizationId:" // Non-empty if system must be bound to an organization.
            }
            res = self.session.post(f"{self.cloud_url}/cdb/systems/bind", headers=login_auth_header, json=sys_payload, verify=False, allow_redirects=True)

            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                data = res.json()
                cloud_info = {
                    "systemId": data.get("id"),
                    "authKey": data.get("authKey"),
                    "owner": data.get("ownerAccountEmail")
                }
                self.session.post(f"{self.local_url}/rest/v2/system/cloudBind", json=cloud_info, verify=False, allow_redirects=True)
                logger.info(f"{self.system_name} : Connected to {self.cloud_host} bind to {self.cloud_account}'s account")
                logger.info(f"{self.system_name} : Cloud System Id = {data.get('id')}")
                return True           
        except requests.exceptions.HTTPError as e:
            logger.error(f"{self.system_name} : connect_system_to_cloud, Can't connect the system to the cloud")
            logger.error(res.status_code)
            logger.debug(res.content)
            logger.debug(e)
            return False

    def _detach_system_from_cloud(self):
        try:
            detach_cloud_info = {
                "password": self.local_admin_password,
                "userAgent": "3rd_party_tool"
            }
            res = self.session.post(f"{self.local_url}/rest/v2/system/cloudUnbind", json=detach_cloud_info, verify=False, allow_redirects=True)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                logger.info( f"{self.system_name} : Disconnect from {self.cloud_host} , detach from {self.cloud_account}'s account.")
                return True          
        except requests.exceptions.HTTPError as e:
            logger.error(f"{self.system_name}: detach_system_from_cloud, can't detach but still connect to the cloud")
            logger.error(res.status_code)
            logger.debug(res.content)
            logger.debug(e)
            return False

    def _setup_connect_to_cloud(self, current_cloud_state):
        logger.debug(f"{self.system_name} : Previous Cloud connected state = {current_cloud_state}") #Cloud System ID or None
        if current_cloud_state == "": 
            if self.__need_to_connect_to_cloud():
                if self._connect_system_to_cloud():
                    current_cloud_state = "CONNECTED"
            else:
                current_cloud_state = "DISCONNECTED(LOCAL)"                    
        elif current_cloud_state == "UNKNOWN":
            logger.warning(f"{self.system_name} has unknown state for Cloud connect, state has not changed.")
        else:
            if self.__need_to_connect_to_cloud():
                current_cloud_state = "CONNECTED"
            else:
                if self._detach_system_from_cloud():
                    current_cloud_state = "DISCONNECTED(LOCAL)"  
                else:
                    current_cloud_state = "CONNECTED"
                    logger.warning(f"{self.system_name} has unknown state for cloud connection, state remains no changed - Connected")
        
        logger.info(f"{self.system_name} : Cloud connect has been completed.")
        logger.info(f"{self.system_name} : Current Cloud connected state = {current_cloud_state}") 
        
        return current_cloud_state

    ######
    def __need_to_enable_auto_discovery(self):
        if self.enable_auto_discovery == "True":
            return True
        else:
            return False

    def _configure_auto_discovery(self,state):
        logger.debug(f"{self.system_name} : configure_auto_discovery to {state}")
        try:
            res = self.session.patch(f"{self.local_url}/rest/v2/system/settings", 
                json={"autoDiscoveryEnabled": state, "autoDiscoveryResponseEnabled": state},
                verify=False,
                allow_redirects=True)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"Auto discovery on {self.system_name} remains the same state")
            logger.error(res.status_code)
            logger.debug(res.content)
            logger.debug(e)
            return False

    def _setup_auto_discovery(self,current_auto_discover_state):
        logger.debug(f"{self.system_name} : Auto discovery previous state = {current_auto_discover_state}")
        if current_auto_discover_state == "UNKNOWN":
            logger.warning(
                f"{self.system_name} : Auto discovery current state = {current_auto_discover_state}")
        else:
            if self.__need_to_enable_auto_discovery():
                if self._configure_auto_discovery(True):
                    current_auto_discover_state = "ENABLED"
                    logger.debug(
                        f"{self.system_name} : Auto discovery state has been changed. Current state = {current_auto_discover_state}")
                else:
                    print(f"[ERROR] Auto discovery state has not been changed. Current state = {current_auto_discover_state} )")
                    logger.error(
                        f"{self.system_name} : setup_auto_discovery. Auto discovery state has not been changed. Current state = {current_auto_discover_state} )")
            else:
                if self._configure_auto_discovery(False):
                    current_auto_discover_state = "DISABLED"
                    logger.debug(f"{self.system_name} : Auto discovery has been disabled")
                else:
                    print(f"[ERROR] Auto discovery state has not been changed. Current state = {current_auto_discover_state} ")
                    logger.error(
                        f"{self.system_name} : setup_auto_discovery. Auto discovery state has not been changed. Current state = {current_auto_discover_state} ")

        logger.info(f"{self.system_name} : Auto discovery configuration has been completed.")
        logger.info(f"{self.system_name} : Current Auto discovery state = {current_auto_discover_state}")
        return current_auto_discover_state           
    
    ######
    def __need_to_enable_camera_optimization(self):
        if self.enable_camera_optimization == "True":
            return True
        else:
            return False

    def _configure_camera_optimization(self,state):
        logger.debug(f"{self.system_name} : configure_camera_optimization to {state}")
        try:
            res = self.session.patch(f"{self.local_url}/rest/v2/system/settings", 
                json={"cameraSettingsOptimization": state},
                verify=False,
                allow_redirects=True)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"configure_camera_optimization, System optmization on {self.system_name} remains the same status")
            logger.error(res.status_code)
            logger.debug(res.content)
            logger.debug(e)
            return False

    def _setup_camera_optimization(self,current_camera_optimization_state):
        logger.debug(f"{self.system_name} : Camera optimization previous state = {current_camera_optimization_state}")
        if current_camera_optimization_state == "UNKNOWN":
            logger.warning(
                f"{self.system_name} :Camera Optimoptimizationization current state = {current_camera_optimization_state} )")
        else:
            if self.__need_to_enable_camera_optimization():
                if self._configure_camera_optimization(True):
                    current_camera_optimization_state = "ENABLED"
                    logger.debug(
                        f"{self.system_name} : Camera optimization state has been changed. Current state = {current_camera_optimization_state}")
                else:
                    print(f"[ERROR] Camera optimization state has not been changed. Current state = {current_camera_optimization_state}")
                    logger.error(
                        f"{self.system_name} : setup_camera_optimization, Camera optimization state has not been changed. Current state = {current_camera_optimization_state}")
            else:
                if self._configure_camera_optimization(False):
                    current_camera_optimization_state = "DISABLED"
                    logger.debug(
                        f"{self.system_name} : Camera optimization state has been changed. Current state = {current_camera_optimization_state}")
                else:
                    print(f"[ERROR] Operation failed. Camera optimization state has not been changed. Current state = {current_camera_optimization_state} ")
                    logger.error(
                        f"{self.system_name} : setup_camera_optimization, Camera optimization state has not been changed. Current state = {current_camera_optimization_state} ")

        logger.info(f"{self.system_name} : Camera optimization configuration has been completed.")
        logger.info(f"{self.system_name} : Current Camera optimization state = {current_camera_optimization_state}")
        return current_camera_optimization_state
           
    ######
    def __need_to_enable_anonymous_statistics_report(self):
        if self.allow_anonymous_statistics_report == "True":
            return True
        else:
            return False

    def _configure_anonymous_statistics_report(self,state):
        logger.debug(f"{self.system_name} : configure_anonymous_statistics_report to {state}")
        try:
            res = self.session.patch(f"{self.local_url}/rest/v2/system/settings", 
                json={"statisticsAllowed": state},
                verify=False,
                allow_redirects=True)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"configure_anonymous_statistics_report. Anonymous statistics report on {self.system_name} remains the same state")
            logger.error(res.status_code)
            logger.debug(res.content)
            logger.debug(e)
            return False

    def _setup_anonymous_statistics_report(self,current_anonymous_statistics_report_state):
        logger.debug(
            f"{self.system_name} : setup_anonymous_statistics_report, Anonymous statistics report previous state = {current_anonymous_statistics_report_state}")
        if current_anonymous_statistics_report_state == "UNKNOWN":
            logger.warning(
                f"{self.system_name} : setup_anonymous_statistics_report, Anonymous statistics report current state = {current_anonymous_statistics_report_state}")
        else:
            if self.__need_to_enable_anonymous_statistics_report():
                if self._configure_anonymous_statistics_report(True):
                    current_anonymous_statistics_report_state = "ENABLED"
                    logger.debug(
                        f"{self.system_name} : setup_anonymous_statistics_report, Anonymous statistics report state has been changed. Current state = {current_anonymous_statistics_report_state}")
                else:
                    print(f"[ERROR] Operation failed. Anonymous statistics report state has not been changed. Current state = {current_anonymous_statistics_report_state}")
                    logger.error(
                        f"{self.system_name} : setup_anonymous_statistics_report, Anonymous statistics report state has not been changed. Current state = {current_anonymous_statistics_report_state}")
            else:
                if self._configure_anonymous_statistics_report(False):
                    current_anonymous_statistics_report_state = "DISABLED"
                    logger.debug(
                        f"{self.system_name} : setup_anonymous_statistics_report, Anonymous statistics report state has been changed. Current state = {current_anonymous_statistics_report_state}")
                else:
                    print(f"[ERROR] Operation failed. Anonymous statistics report state has not been changed. Current state = {current_anonymous_statistics_report_state}")
                    logger.error(
                        f"{self.system_name} : setup_anonymous_statistics_report, Anonymous Statistics Report state has not been changed. Current state = {current_anonymous_statistics_report_state}")
               
        logger.info(f"{self.system_name} : Anonymous statistics report configuration has been completed.")
        logger.info(f"{self.system_name} : Current Anonymous statistics report state = {current_anonymous_statistics_report_state}")
        return current_anonymous_statistics_report_state

    def __set_system_name(self):
        configuration_payload = {"systemName": self.system_name}
        try:
            res = self.session.patch(f"{self.local_url}/rest/v2/system/settings", json=configuration_payload, verify=False)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            logger.info(f"System Name is changed to {self.system_name}")
        except requests.exceptions.HTTPError as e:
            logger.error(f"System Name does not set successfully, desired value = {self.system_name}")
            logger.error(res.status_code)
            logger.debug(res.content)
            logger.debug(e)
        
    def _initialize_system(self):
        configuration_payload = {
            "name": self.system_name,
            "settings": {},
            "local": {
                "password": self.local_admin_password
            }
        }
        try:
            res = self.session.post(f"{self.local_url}/rest/v2/system/setup", json=configuration_payload, verify=False)
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            logger.info(f"System setup is completed")
        except requests.exceptions.HTTPError as e:
            logger.error(f"System Setup failed")
            logger.error(res.status_code)
            logger.debug(res.content)
            logger.debug(e)

    ######   
    def setup_system(self):   
        connect_to_cloud = False
        auto_discovery = True
        anonymous_statistics_report = True
        camera_optimization = True 
        system_settings_dict = asdict(self.system_settings)

        logging.info(f"{self.system_name} : ==============")
        #First time login attempt
        self.login("admin")
        self._initialize_system()
        self.session.delete(f"{self.local_url}/rest/v2/login/sessions/current", verify=False)

        #Get Current system settings
        self.login("admin", self.local_admin_password)
        current_system_settings = self.get_current_system_settings(system_settings_dict)

        #Connect to cloud operation
        connect_to_cloud = self._setup_connect_to_cloud(current_system_settings["cloudSystemID"])

        #System name 
        #Case 1 : The system is detached from the cloud, it will need system name to be set again.
        #Case 2 : If the operation is an operation of changing the system name. (cloud/non-cloud)
        if current_system_settings["systemName"] != self.system_name:
            self.__set_system_name()
        #Auto_discover
        auto_discovery = self._setup_auto_discovery(current_system_settings["autoDiscoveryEnabled"])
        #Camera optimization
        camera_optimization = self._setup_camera_optimization(current_system_settings["cameraSettingsOptimization"])
        #Configure Anonymous statistics report
        anonymous_statistics_report = self._setup_anonymous_statistics_report(current_system_settings["statisticsAllowed"])
        system_setup_result = {
            "system_name":self.system_name, 
            "connect_to_cloud":connect_to_cloud, 
            "auto_discovery":auto_discovery,
            "anonymous_statistics_report":anonymous_statistics_report,
            "camera_optimization":camera_optimization
        }
        self.session.delete(f"{self.local_url}/rest/v2/login/sessions/current", verify=False)
        return system_setup_result