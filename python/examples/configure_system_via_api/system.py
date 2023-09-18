#!/usr/bin/python3
import logging
import requests
import sys
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


logging.basicConfig(filename="system_setup.log",
                    filemode='a',
                    format='%(asctime)s %(levelname)s %(message)s',
                    datefmt="%Y-%m-%d %H:%M:%S",
                    level=logging.INFO)
logger = logging.getLogger(__name__)

#For checking current system settings.
PARAMETER_SET = "cloudSystemID,autoDiscoveryEnabled,autoDiscoveryResponseEnabled,cameraSettingsOptimization,statisticsAllowed"
HTTP_TIMEOUT = 5
class system:

    def __init__(self, ip_address, port, 
                 system_name, local_admin_password, 
                 cloud_host, cloud_account, cloud_password, connect_to_cloud, 
                 enable_auto_discovery,
                 allow_anonymous_statistics_report,
                 enable_camera_optimization,):
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
        session.post(f"{local_url}/rest/v2/login/sessions", timeout=(HTTP_TIMEOUT), json=credentials, verify=False)

    def get_current_system_settings(self,session):
        local_url = f"https://{self.ip_address}:{self.port}"
        current_system_settings = {
            "cloudSystemID":"",
            "autoDiscoveryEnabled":"False",
            "autoDiscoveryResponseEnabled":"False",
            "cameraSettingsOptimization":"False",
            "statisticsAllowed":"False"}
        try:
            self.login(session,self.local_admin_password)
            res = session.get(f"{local_url}/rest/v2/system/settings?_with={PARAMETER_SET}") 
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                settings = res.json()
                session.delete(f"{local_url}/rest/v2/login/sessions")               
                logger.info(f"{self.system_name} : Current Settings = {settings}")
                for setting in settings:
                    if setting in current_system_settings.keys():
                        current_system_settings[setting] = settings.get(setting)
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. {self.system_name} will not be connecting to the cloud")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            current_system_settings = {
                "cloudSystemID":"Unknown",
                "autoDiscoveryEnabled":"Unknown",
                "autoDiscoveryResponseEnabled":"Unknown",
                "cameraSettingsOptimization":"Unknown",
                "statisticsAllowed":"Unknown"}
        return current_system_settings

    ######
    def is_user_want_to_connect_to_cloud(self):
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
                r = session.post(f"{local_url}/rest/v2/system/cloudBind", json=cloud_info)
                session.delete(f"{local_url}/rest/v2/login/sessions")               
                logger.info(f"{self.system_name} : Connected to {self.cloud_host} bind to {self.cloud_account}'s account")
                logger.info(f"{self.system_name} : Cloud System Id = {data.get('id')}")
                return True           
        except requests.exceptions.HTTPError as e:
            logger.error(f"{self.system_name} : Something went wrong, will not be connecting to the cloud")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def detach_system_to_cloud(self,session):
        local_url = f"https://{self.ip_address}:{self.port}"
        cloud_url = f"https://{self.cloud_host}"
        try:
            self.login(session,self.local_admin_password)
            detach_cloud_info = {
                "password": self.local_admin_password,
                "userAgent": "3rd_party_tool"
            }
            session.post(f"{local_url}/rest/v2/system/cloudUnbind", json=detach_cloud_info)
            session.delete(f"{local_url}/rest/v2/login/sessions")               
            logger.info( f"{self.system_name}: Disconnect from {self.cloud_host} , detach from {self.cloud_account}'s account.")
            return True           
        except requests.exceptions.HTTPError as e:
            logger.error(f"{self.system_name}: Something went wrong, will be still connecting to the cloud")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def setup_connect_to_cloud(self, session, current_cloud_state):
        logger.info(f"{self.system_name} : Previous Cloud State = {current_cloud_state}") #Cloud System ID or None
        if current_cloud_state == "": 
            if self.is_user_want_to_connect_to_cloud():            
                if self.connect_system_to_cloud(session):
                    current_cloud_state = "CONNECTED"
            else:
                current_cloud_state = "DISCONNECTED(LOCAL)"                    
        elif current_cloud_state == "UNKNOWN":
            logger.warning(f"{self.system_name} has unknown state for cloud connection, state has not changed.")
        else:
            if self.is_user_want_to_connect_to_cloud():
                current_cloud_state = "CONNECTED"
            else:
                if self.detach_system_to_cloud(session):
                    current_cloud_state = "DISCONNECTED(LOCAL)"  
                else:
                    current_cloud_state = "CONNECTED"
                    logger.warning(f"{self.system_name} has unknown state for cloud connection, state remains no changed - Connected)")
        
        logger.info(f"{self.system_name} : Complete Cloud connect operation.")
        logger.info(f"{self.system_name} : Current Cloud Connected state = {current_cloud_state}") 
        
        return current_cloud_state

    ######
    def is_user_want_to_enable_auto_discovery(self):
        if self.enable_auto_discovery == "True":
            return True
        else:
            return False

    def configure_auto_discovery_on_system(self,session,state):
        local_url = f"https://{self.ip_address}:{self.port}"
        try:
            self.login(session,self.local_admin_password)
            res = session.patch(f"{local_url}/rest/v2/system/settings", 
                json={"autoDiscoveryEnabled": state, "autoDiscoveryResponseEnabled": state})
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                session.delete(f"{local_url}/rest/v2/login/sessions")
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. Auto discovery on {self.system_name} remains same state")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def setup_auto_discovery(self,session,current_auto_discover_state):
        logger.info(f"{self.system_name} : Auto Discover previous state = {current_auto_discover_state}")
        if current_auto_discover_state == "UNKNOWN":
            logger.warning(
                f"{self.system_name} : Auto Discover Report state = {current_auto_discover_state}")
        else:
            if self.is_user_want_to_enable_auto_discovery():
                if self.configure_auto_discovery_on_system(session, True):
                    current_auto_discover_state = "ENABLED"
                    logger.debug(
                        f"{self.system_name} : Auto Discovery state has been changed. State = {current_auto_discover_state}")
                else:
                    print(f"{self.system_name} : Operation failed. Auto Discovery state has not been changed. State = {current_auto_discover_state} )")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Auto Discovery state has not been changed. State = {current_auto_discover_state} )")
            else:
                if self.configure_auto_discovery_on_system(session, False):
                    current_auto_discover_state = "DISABLED"
                    logger.debug(f"{self.system_name} : Auto Discovery has been disabled")
                else:
                    print(f"{self.system_name} : Operation failed. Auto Discovery state has not been changed. State = {current_auto_discover_state} )")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Auto Discovery state has not been changed. State = {current_auto_discover_state} )")

        logger.info(f"{self.system_name} : Complete Auto discovery operation.")
        logger.info(f"{self.system_name} : Current Auto discovery state = {current_auto_discover_state}")
        return current_auto_discover_state           
    
    ######
    def is_user_want_to_enable_camera_optimization(self):
        if self.enable_camera_optimization == "True":
            return True
        else:
            return False

    def configure_camera_optimization_on_system(self,session,state):
        local_url = f"https://{self.ip_address}:{self.port}"
        logger.debug(f"{self.system_name} : configure_camera_optimization_on_system to {state}")
        try:
            self.login(session,self.local_admin_password)
            res = session.patch(f"{local_url}/rest/v2/system/settings", 
                json={"cameraSettingsOptimization": state})
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                session.delete(f"{local_url}/rest/v2/login/sessions")
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. System optmization on {self.system_name} remains same status")
            logger.debug(res.status_code)
            logger.debug(res.content)
            logger.error(e)
            return False

    def setup_camera_optimization(self,session,current_camera_optimization_state):
        logger.info(f"{self.system_name} : Camera Optimization previous state = {current_camera_optimization_state}")
        if current_camera_optimization_state == "UNKNOWN":
            logger.warning(
                f"{self.system_name} :  Camera Optimization state = {current_camera_optimization_state} )")
        else:
            if self.is_user_want_to_enable_camera_optimization():
                if self.configure_camera_optimization_on_system(session, True):
                    current_camera_optimization_state = "ENABLED"
                    logger.debug(
                        f"{self.system_name} :  Camera Optimization state has been changed. State = {current_camera_optimization_state}")
                else:
                    print(f"{self.system_name} : Operation failed. Camera Optimization state has not been changed. State = {current_camera_optimization_state}")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Camera Optimization state has not been changed. State = {current_camera_optimization_state}")
            else:
                if self.configure_camera_optimization_on_system(session, False):
                    current_camera_optimization_state = "DISABLED"
                    logger.debug(
                        f"{self.system_name} : Camera Optimization state has been changed. State = {current_camera_optimization_state}")
                else:
                    print(f"{self.system_name} : Operation failed. Camera Optimization state has not been changed. State = {current_camera_optimization_state} )")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Camera Optimization state has not been changed. State = {current_camera_optimization_state} )")

        logger.info(f"{self.system_name} : Complete Camera Optimization operation.")
        logger.info(f"{self.system_name} : Current Camera Optimization state = {current_camera_optimization_state}")
        return current_camera_optimization_state
           
    ######
    def is_user_want_to_enable_anonymous_statistics_report(self):
        if self.allow_anonymous_statistics_report == "True":
            return True
        else:
            return False

    def configure_anonymous_statistics_report_on_system(self,session,state):
        local_url = f"https://{self.ip_address}:{self.port}"
        try:
            self.login(session,self.local_admin_password)
            res = session.patch(f"{local_url}/rest/v2/system/settings", 
                json={"statisticsAllowed": state})
            if res.status_code != 200:
                raise(requests.exceptions.HTTPError)
            else:
                session.delete(f"{local_url}/rest/v2/login/sessions")
                return True
        except requests.exceptions.HTTPError as e:
            logger.error(f"Something went wrong. Anonymous statistics on {self.system_name} remains same state")
            logger.warning(res.status_code)
            logger.warning(res.content)
            logger.error(e)
            return False

    def setup_anonymous_statistics_report(self,session,current_anonymous_statistics_report_state):
        logger.info(
            f"{self.system_name} : Anonymous Statistics Report previous state = {current_anonymous_statistics_report_state}")
        if current_anonymous_statistics_report_state == "Unknown":
            logger.warning(
                f"{self.system_name} :  Anonymous Statistics Report state = {current_anonymous_statistics_report_state} )")
        else:
            if self.is_user_want_to_enable_anonymous_statistics_report():
                if self.configure_anonymous_statistics_report_on_system(session,True):
                    current_anonymous_statistics_report_state = "ENABLED"
                    logger.debug(
                        f"{self.system_name} :  Anonymous Statistics Report state has been changed. State = {current_anonymous_statistics_report_state}")
                else:
                    print(f"{self.system_name} : Operation failed. Anonymous Statistics Report state has not been changed. State = {current_anonymous_statistics_report_state}")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Anonymous Statistics Report state has not been changed. State = {current_anonymous_statistics_report_state}")
            else:
                if self.configure_anonymous_statistics_report_on_system(session,False):
                    current_anonymous_statistics_report_state = "DISABLED"
                    logger.debug(
                        f"{self.system_name} : Anonymous Statistics Report state has been changed. State = {current_anonymous_statistics_report_state}")
                else:
                    print(f"{self.system_name} : Operation failed. Anonymous Statistics Report state has not been changed. State = {current_anonymous_statistics_report_state}")
                    logger.debug(
                        f"{self.system_name} : Operation failed. Anonymous Statistics Report state has not been changed. State = {current_anonymous_statistics_report_state}")
               
        logger.info(f"{self.system_name} : Complete Anonymous Statistics operation.")
        logger.info(f"{self.system_name} : Current Anonymous Statistics Report state = {current_anonymous_statistics_report_state}")
        return current_anonymous_statistics_report_state

    ######   
    def setup_system(self):   
        local_url = f"https://{self.ip_address}:{self.port}"
        connect_to_cloud = False
        auto_discovery = True
        anonymous_statistics_report = True
        camera_optimization = True 
        
        logging.info(f"{self.system_name} : ==============")
        try:
            with requests.Session() as session:
                self.login(session)
                body = {
                    "name": self.system_name,
                    "settings": {},
                    "local": {
                        "password": self.local_admin_password
                    }
                }
                try: 
                    session.post(f"{local_url}/rest/v2/system/setup", json=body, verify=False)
                    #Get Current system settings
                    current_settings = self.get_current_system_settings(session)
                    session.delete(f"{local_url}/rest/v2/login/sessions", verify=False)
                    #Connect to cloud operation
                    connect_to_cloud = self.setup_connect_to_cloud(session,current_settings["cloudSystemID"])
                    #Auto_discover
                    auto_discovery = self.setup_auto_discovery(session,current_settings["autoDiscoveryEnabled"])
                    #Camera optimization
                    camera_optimization = self.setup_camera_optimization(session,current_settings["cameraSettingsOptimization"])
                    #Configure Anonymous statistics report
                    anonymous_statistics_report = self.setup_anonymous_statistics_report(session,current_settings["statisticsAllowed"])
                    
                    system_setup_result = {
                        "system_name":self.system_name, 
                        "connect_to_cloud":connect_to_cloud, 
                        "auto_discovery":auto_discovery,
                        "anonymous_statistics_report":anonymous_statistics_report,
                        "camera_optimization":camera_optimization}
                    return system_setup_result
                except requests.exceptions.HTTPError as e:
                    logging.error(f"{self.system_name} : Something went wrong. Operation suspended")
                    logging.debug(e)        
        except requests.exceptions.ConnectionError as e:
            logging.error(f"{self.system_name} : Something went wrong. Operation suspended")
            logging.debug(e)