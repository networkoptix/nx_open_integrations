#!/usr/bin/python3
"""
Manages VMS (Video Management System) settings and configuration.

This module provides the VmsSystem class to interact with a VMS, allowing for 
initialization, configuration of various settings like cloud connectivity, 
auto-discovery, camera optimization, and statistics reporting.
"""

import configparser
import json
import logging
import requests
import urllib3
from dataclasses import dataclass, asdict
from typing import Dict, Any, List, Optional, Callable, Union

# Disable InsecureRequestWarning: Not recommended for production
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Logging configuration
logging.basicConfig(
    filename="configure_system.log",
    filemode='a',
    format='%(asctime)s %(levelname)s %(message)s',
    datefmt="%Y-%m-%d %H:%M:%S",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# --- Constants for states ---
STATE_UNKNOWN = "UNKNOWN"
STATE_ENABLED = "ENABLED"
STATE_DISABLED = "DISABLED"
STATE_CONNECTED = "CONNECTED"
STATE_DISCONNECTED_LOCAL = "DISCONNECTED(LOCAL)"

# --- API Path Constants ---
API_V3_BASE = "/rest/v3"
LOGIN_SESSIONS_PATH = f"{API_V3_BASE}/login/sessions"
SYSTEM_SETTINGS_PATH = f"{API_V3_BASE}/system/settings"
SYSTEM_CLOUD_BIND_PATH = f"{API_V3_BASE}/system/cloud/bind"
SYSTEM_CLOUD_UNBIND_PATH = f"{API_V3_BASE}/system/cloud/unbind"
SYSTEM_SETUP_PATH = f"{API_V3_BASE}/system/setup"

CDB_OAUTH_TOKEN_PATH = "/cdb/oauth2/token"
PARTNERS_API_V3_CLOUD_SYSTEMS_PATH = "/partners/api/v3/cloud_systems/"
CDB_SYSTEMS_BIND_PATH = "/cdb/systems/bind"


@dataclass
class VmsSystemSettings:
    """Dataclass to hold VMS system settings."""
    customization: str
    systemName: str
    cloudSystemID: str  # Can be empty, actual ID.
    organizationId: str # Ensure this is correctly populated if used.
    cloud_host: str
    autoDiscoveryEnabled: bool = False
    cameraSettingsOptimization: bool = False
    statisticsAllowed: bool = False


class VmsSystem:
    def __init__(self, configuration_file: str):
        """
        Initializes the VmsSystem instance.

        Args:
            configuration_file: Path to the system configuration INI file.
        
        Raises:
            FileNotFoundError: If cloud_hosts.json is not found.
            configparser.Error: If there's an issue reading the config file.
            KeyError: If essential keys are missing in the config or JSON data.
        """
        try:
            system_configuration = configparser.ConfigParser()
            if not system_configuration.read(configuration_file):
                raise configparser.Error(
                    f"Configuration file {configuration_file} not found or empty."
                )

            with open('cloud_hosts.json', 'r') as file:
                product_info = json.load(file)

            # Server settings
            server_config = system_configuration["server"]
            self.ip_address: str = server_config["ip_address"]
            self.port: str = server_config["port"]
            self.system_name: str = server_config["system_name"]
            self.local_admin_password: str = server_config["local_admin_password"]
            self.local_url: str = f"https://{self.ip_address}:{self.port}"

            # Product and cloud settings
            system_settings_config = system_configuration["system_settings"]
            self.product_name: str = system_settings_config["product"]
            self.customization: str = self._get_product_info(
                product_info.get("data", []), "customization"
            )
            self.cloud_host: str = self._get_product_info(
                product_info.get("data", []), "cloud_host"
            )
            self.cloud_url: str = f"https://{self.cloud_host}"

            # Cloud account details
            cloud_config = system_configuration["cloud"]
            self.cloud_account: str = cloud_config["cloud_account"]
            self.cloud_password: str = cloud_config["cloud_password"]

            # Consider if organizationId should be loaded from config
            # if connect_to_organization is True.
            self.connect_to_organization: bool = cloud_config.getboolean(
                "connect_to_organization"
            )
            self.organizationId: str = system_settings_config["organization_id"]


            # Feature flags from config
            self.connect_to_cloud: bool = system_settings_config.getboolean(
                "connect_to_cloud"
            )
            self.enable_auto_discovery: bool = system_settings_config.getboolean(
                "enable_auto_discovery"
            )
            self.allow_anonymous_statistics_report: bool = system_settings_config.getboolean(
                "allow_anonymous_statistics_report"
            )
            self.enable_camera_optimization: bool = system_settings_config.getboolean(
                "enable_camera_optimization"
            )

            self.system_settings = VmsSystemSettings(
                customization=self.customization,
                systemName=self.system_name,
                cloudSystemID="",  # Will be updated by get_current_system_settings
                organizationId=self.organizationId,
                cloud_host=self.cloud_host,
                autoDiscoveryEnabled=True,
                cameraSettingsOptimization=True,
                statisticsAllowed=True
            )
            self.session = requests.Session()
            self.http_timeout: int = 5 # Default timeout in seconds

        except (FileNotFoundError, configparser.Error, KeyError) as e:
            logging.error(f"VmsSystem initialization failed: {e}")
            print(f'[ERROR] VmsSystem object initialization was not successful: {e}')
            raise  # Re-raise after logging
        except Exception as e: # Catch any other unexpected errors
            logging.error(f"Unexpected error during VmsSystem initialization: {e}")
            print(f'[ERROR] Unexpected error during VmsSystem object initialization.')
            raise

    def _get_product_info(self, products_data: List[Dict[str, Dict[str, str]]], key: str) -> str:
        """
        Retrieves a specific piece of product information (e.g., cloud_host, customization).

        Args:
            products_data: A list of product dictionaries. Each dictionary is expected
                           to have one entry: {product_name: {info_key: info_value, ...}}.
            key: The specific information key to retrieve (e.g., "cloud_host").

        Returns:
            The value for the specified key if found, otherwise an empty string.
        """
        for product_entry in products_data:
            for name, info in product_entry.items():
                if self.product_name == name:
                    return info.get(key, "")
        logger.warning(
            f"Product '{self.product_name}' or key '{key}' not found in cloud_hosts.json."
        )
        return ""

    def set_http_timeout(self, timeout_in_seconds: int):
        self.http_timeout = timeout_in_seconds

    def _get_access_token_via_ms(self, username: str, password: str) -> Optional[str]:
        credentials = {"username": username, "password": password, "setCookie": True}
        try:
            res = self.session.post(
                f"{self.local_url}{LOGIN_SESSIONS_PATH}",
                json=credentials,
                timeout=self.http_timeout,
                verify=False, # Ignore SSL certificate verification (due to self-signed)
                allow_redirects=True
            )
            res.raise_for_status()
            return res.json().get("token")
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to get MS access token for {username}: {e}")
            return None

    def _get_access_token_via_cdb(self, username: str, password: str) -> Optional[str]:
        cloud_credentials = {
            "username": username,
            "password": password,
            'grant_type': 'password',
            'response_type': 'token',
            'client_id': '3rd_party_tool'
        }
        try:
            res = self.session.post(
                f"{self.cloud_url}{CDB_OAUTH_TOKEN_PATH}",
                json=cloud_credentials,
                timeout=self.http_timeout,
                verify=False
            )
            res.raise_for_status()
            return res.json().get("access_token")
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to get CDB access token for {username}: {e}")
            return None

    def _get_authentication_header(self, bearer_token: Optional[str]) -> Dict[str, str]:
        if bearer_token:
            return {"Authorization": f"Bearer {bearer_token}"}
        return {}

    def login(self, username: str, password: str = "admin", scheme: str = "local") -> Dict[str, str]:
        """
        Logs into the system (either local or cloud) and returns auth headers.

        Args:
            username: The username for login.
            password: The password for login. Defaults to "admin".
            scheme: "cloud" for cloud login, otherwise local login.

        Returns:
            A dictionary containing the Authorization header, or empty if login fails.
        """
        token: Optional[str] = None
        if scheme == "cloud":
            token = self._get_access_token_via_cdb(username, password)
        else:
            token = self._get_access_token_via_ms(username, password)
        
        if not token:
            logger.warning(f"Login failed for user {username} with scheme '{scheme}'.")
            return {}
        return self._get_authentication_header(token)

    def get_current_system_settings(self) -> Dict[str, Any]:
        """
        Retrieves current system settings from the mediaserver.

        Returns:
            A dictionary of current settings. If retrieval fails, values for
            settable features will be STATE_UNKNOWN.
        """
        # Start with a copy of the default/desired settings structure
        current_settings = asdict(self.system_settings)
        
        try:
            res = self.session.get(
                f"{self.local_url}{SYSTEM_SETTINGS_PATH}",
                timeout=self.http_timeout,
                verify=False,
                allow_redirects=True
            )
            res.raise_for_status()
            
            api_settings = res.json()
            logger.info(f"{self.system_name}: Raw settings from API = {api_settings}")

            # Ensure boolean-like settings are actual booleans if present,
            for key in current_settings:
                if key in api_settings:
                    current_settings[key] = api_settings[key]
                # else: keep the default from VmsSystemSettings or pre-filled value
                #             
        except requests.exceptions.RequestException as e:
            logger.error(f"Failed to get current system settings: {e}")
            if hasattr(e, 'response') and e.response is not None:
                logger.warning(f"Status: {e.response.status_code}, Content: {e.response.content}")
            print(f"[ERROR] Can't get the current system settings for {self.system_name}.")
            
            # Populate with UNKNOWN state for critical settings if fetch fails
            current_settings.update({
                "systemName": self.system_name,
                "cloudSystemID": STATE_UNKNOWN, # cloudSystemID might be "" or actual ID
                "autoDiscoveryEnabled": STATE_UNKNOWN,
                "autoDiscoveryResponseEnabled" : STATE_UNKNOWN,
                "cameraSettingsOptimization": STATE_UNKNOWN,
                "statisticsAllowed": STATE_UNKNOWN
            })
        return current_settings

    def _should_connect_to_organization(self) -> bool:
        return self.connect_to_organization

    def _connect_system_to_cloud(self) -> bool:
        try:
            login_auth_header = self.login(self.cloud_account, self.cloud_password, "cloud")
            if not login_auth_header: # Login failed
                logger.error(f"{self.system_name}: Cloud login failed, cannot connect to cloud.")
                return False

            sys_payload: Dict[str, str]
            endpoint: str

            if self._should_connect_to_organization():
                logger.info(
                    f"{self.system_name}: Connecting system to organization "
                    f"'{self.system_settings.organizationId}'."
                )
                # self.system_settings.organizationId is "" by default.
                # This needs to be a valid ID if connect_to_organization is True.
                # An empty string might be rejected by the API or have unintended consequences.
                # It can be rertrived by CDB APIs or Nx Connect Web interface.
                if not self.system_settings.organizationId:
                    logger.warning(
                        f"{self.system_name}: Attempting to connect to organization "
                        "but organizationId is empty. This will fail."
                    )
                sys_payload = {
                    "name": self.system_name,
                    "customization": self.customization,
                    "organization": self.system_settings.organizationId
                }
                endpoint = f"{self.cloud_url}{PARTNERS_API_V3_CLOUD_SYSTEMS_PATH}"
            else:
                logger.info(
                    f"{self.system_name}: Connecting system to cloud account "
                    f"'{self.cloud_account}'."
                )
                sys_payload = {
                    "name": self.system_name,
                    "customization": self.customization
                }
                endpoint = f"{self.cloud_url}{CDB_SYSTEMS_BIND_PATH}"
            
            res_cloud_bind = self.session.post(
                endpoint, headers=login_auth_header, json=sys_payload,
                verify=False, allow_redirects=True, timeout=self.http_timeout
            )
            #print(json.dumps(res_cloud_bind.json(), indent=2))
            res_cloud_bind.raise_for_status()
            

            data = res_cloud_bind.json()
            cloud_info = {
                "systemId": data.get("id"),
                "authKey": data.get("authKey"),
                "owner": self.cloud_account            
            }

            # For organizations, include organizationId if applicable
            if self._should_connect_to_organization():
                cloud_info["organizationId"] = self.system_settings.organizationId
            
            login_auth_header = self.login("admin", self.local_admin_password)
            
            res_local_bind = self.session.post(
                f"{self.local_url}{SYSTEM_CLOUD_BIND_PATH}", headers=login_auth_header,
                json=cloud_info, verify=False, allow_redirects=True, timeout=self.http_timeout
            )
            
            #print(f"here:{json.dumps(res_local_bind.json(), indent=2)}")
            if res_local_bind.status_code == 200 or res_local_bind.status_code == 204:
                logger.info(f"{self.system_name}: Successfully connected to {self.cloud_host} and "
                            f"bound to {self.cloud_account}'s account. Cloud System ID: {data.get('id')}")
                return True
            else:
                res_local_bind.raise_for_status()

            '''
            logger.info(
                f"{self.system_name}: Successfully connected to {self.cloud_host} and "
                f"bound to {self.cloud_account}'s account. Cloud System ID: {data.get('id')}"
            )
            return True
            '''
        except requests.exceptions.RequestException as e:
            logger.error(f"{self.system_name}: Failed to connect system to cloud: {e}")
            if hasattr(e, 'response') and e.response is not None:
                logger.debug(f"Status: {e.response.status_code}, Content: {e.response.content}")
            return False

    def _detach_system_from_cloud(self) -> bool:
        try:
            detach_cloud_info = {
                "password": self.local_admin_password,
                "userAgent": "3rd_party_tool" 
            }
            res = self.session.post(
                f"{self.local_url}{SYSTEM_CLOUD_UNBIND_PATH}", json=detach_cloud_info,
                verify=False, allow_redirects=True, timeout=self.http_timeout
            )
            res.raise_for_status()
            logger.info(
                f"{self.system_name}: Successfully detached from {self.cloud_account}."
            )
            return True
        except requests.exceptions.RequestException as e:
            logger.error(f"{self.system_name}: Failed to detach system from cloud: {e}")
            if hasattr(e, 'response') and e.response is not None:
                logger.debug(f"Status: {e.response.status_code}, Content: {e.response.content}")
            return False

    def _setup_connect_to_cloud(self, current_cloud_id: Optional[str]) -> str:
        """
        Manages the system's connection to the cloud based on configuration.

        Args:
            current_cloud_id: The current cloud system ID (e.g., from GET settings),
        
        Returns:
            Status : STATE_CONNECTED, STATE_DISCONNECTED_LOCAL, or current_cloud_id if UNKNOWN.
        """
        logger.debug(f"{self.system_name}: Current Cloud System ID = '{current_cloud_id}'")
        
        desired_cloud_state = STATE_UNKNOWN # Default if logic doesn't change it

        # Treat empty string, None as not currently bound to a specific cloud system
        is_currently_bound = bool(current_cloud_id) and current_cloud_id != STATE_UNKNOWN

        if current_cloud_id == STATE_UNKNOWN:
            logger.warning(
                f"{self.system_name}: Cloud connection state is UNKNOWN. "
                "Attempting to set desired state."
            )
            # Fall through to logic below, effectively treating UNKNOWN as "not reliably bound"

        if self.connect_to_cloud: # Desired state is connected
            if not is_currently_bound or current_cloud_id == STATE_UNKNOWN:
                logger.info(f"{self.system_name}: Attempting to connect to cloud.")
                if self._connect_system_to_cloud():
                    desired_cloud_state = STATE_CONNECTED
                else:
                    # Failed to connect, if it was UNKNOWN, it remains effectively so.
                    # If it was "" (not bound), it's still not bound.
                    if current_cloud_id == STATE_UNKNOWN:
                        desired_cloud_state = current_cloud_id  
                    else: 
                        STATE_DISCONNECTED_LOCAL
                    logger.error(f"{self.system_name}: Failed to establish cloud connection.")
            else: # Already bound, and we want to be connected
                logger.info(f"{self.system_name}: Already connected (ID: {current_cloud_id}).")
                desired_cloud_state = STATE_CONNECTED
        else: # Desired state is disconnected
            if is_currently_bound:
                logger.info(f"{self.system_name}: Attempting to detach from cloud.")
                if self._detach_system_from_cloud():
                    desired_cloud_state = STATE_DISCONNECTED_LOCAL
                else:
                    # Failed to detach, so it's still effectively connected
                    desired_cloud_state = STATE_CONNECTED 
                    logger.warning(
                        f"{self.system_name}: Failed to detach from cloud. System remains connected."
                    )
            else: # Not bound, and we want to be disconnected
                logger.info(f"{self.system_name}: System is not connected to cloud, as desired.")
                desired_cloud_state = STATE_DISCONNECTED_LOCAL
        
        logger.info(f"{self.system_name}: Cloud connection setup completed. Final state: {desired_cloud_state}")
        return desired_cloud_state

    def _update_system_settings(self, payload: Dict[str, bool]) -> bool:
        """
        Updates system settings via a PATCH request.

        Args:
            payload: Dictionary of settings to update. Values should be boolean.

        Returns:
            True if successful, False otherwise.
        """
        logger.debug(f"{self.system_name}: Updating settings with payload: {payload}")
        try:
            res = self.session.patch(
                f"{self.local_url}{SYSTEM_SETTINGS_PATH}",
                json=payload,
                verify=False, 
                allow_redirects=True,
                timeout=self.http_timeout
            )
            res.raise_for_status()
            return True
        except requests.exceptions.RequestException as e:
            # Log specific details from the response if available
            if hasattr(e, 'response') and e.response is not None:
                status_code = e.response.status_code 
                content = e.response.content
            else :
                status_code = "N/A"
                content = "N/A"
            logger.error(
                f"Failed to update system settings on {self.system_name} with {payload}. "
                f"Error: {e}. Status: {status_code}. Response: {content}"
            )
            return False

    def _configure_auto_discovery(self, state: bool) -> bool:
        logger.debug(f"{self.system_name}: Setting auto-discovery to {state}.")
        return self._update_system_settings({
            "autoDiscoveryEnabled": state,
            "autoDiscoveryResponseEnabled": state # Assuming API supports this mapping
        })

    def _configure_camera_optimization(self, state: bool) -> bool:
        """Configures camera settings optimization."""
        logger.debug(f"{self.system_name}: Setting camera optimization to {state}.")
        return self._update_system_settings({"cameraSettingsOptimization": state})

    def _configure_anonymous_statistics_report(self, state: bool) -> bool:
        """Configures anonymous statistics reporting."""
        logger.debug(f"{self.system_name}: Setting anonymous statistics to {state}.")
        return self._update_system_settings({"statisticsAllowed": state})

    def _setup_boolean_feature(
        self,
        settings_name: str,
        current_feature_state: Union[bool, str], # True, False, or STATE_UNKNOWN
        desired_enabled_state: bool,
        configure_func: Callable[[bool], bool],
    ) -> str:
        """
        Generic helper to set up a boolean feature (enable/disable).

        Args:
            settings_name: Name of the feature for logging.
            current_feature_state: Current state from system (True, False, or STATE_UNKNOWN).
            desired_enabled_state: True if feature should be enabled, False if disabled.
            configure_func: Function of changing a setting (e.g., self._configure_auto_discovery).

        Returns:
            STATE_ENABLED, STATE_DISABLED, or STATE_UNKNOWN status string.
        """
        logger.info(
            f"{self.system_name}: Setting up {settings_name}. "
            f"Current state: {current_feature_state},"
            f"Desired: {'enable' if desired_enabled_state else 'disable'}."
        )
        
        final_reported_state: str

        if current_feature_state == STATE_UNKNOWN:
            logger.warning(
                f"{self.system_name}: {settings_name} current state is UNKNOWN. "
                f"Attempting to set to {'ENABLED' if desired_enabled_state else 'DISABLED'}."
            )
            if configure_func(desired_enabled_state):
                final_reported_state = STATE_ENABLED if desired_enabled_state else STATE_DISABLED
            else:
                final_reported_state = STATE_UNKNOWN # Failed to change from UNKNOWN
                print(f"[ERROR] {settings_name} on {self.system_name} cannot be set from UNKNOWN state.")
        
        elif isinstance(current_feature_state, bool):
            if current_feature_state == desired_enabled_state:
                logger.info(
                    f"{self.system_name}: {settings_name} is already in the desired state "
                    f"({'ENABLED' if desired_enabled_state else 'DISABLED'})."
                )
                final_reported_state = STATE_ENABLED if desired_enabled_state else STATE_DISABLED
            else: # Current state is bool, but different from desired state
                if configure_func(desired_enabled_state):
                    final_reported_state = STATE_ENABLED if desired_enabled_state else STATE_DISABLED
                else:
                    # Configuration failed, state effectively remains as it was
                    final_reported_state = STATE_ENABLED if current_feature_state else STATE_DISABLED
                    print(
                        f"[ERROR] {settings_name} on {self.system_name} failed to change. "
                        f"Remains effectively {final_reported_state}."
                    )
        else: # Should not happen if current_feature_state is bool or STATE_UNKNOWN
            logger.error(
                f"{self.system_name}: {settings_name} has unexpected current state '{current_feature_state}'. "
                "Taking no action."
            )
            final_reported_state = STATE_UNKNOWN # Or convert current_feature_state to string

        logger.info(f"{self.system_name}: {settings_name} setup completed. Reported state: {final_reported_state}")
        return final_reported_state

    def _set_system_name(self) -> bool:
        """Sets the system name on the VMS."""
        logger.info(f"{self.system_name}: Attempting to set system name to '{self.system_name}'.")
        if self._update_system_settings({"systemName": self.system_name}): 
            logger.info(f"System name successfully changed to '{self.system_name}'.")
            return True
        else:
            logger.error(f"Failed to set system name to '{self.system_name}'.")
            try:
                res = self.session.patch(
                    f"{self.local_url}{SYSTEM_SETTINGS_PATH}",
                    json={"systemName": self.system_name},
                    verify=False, timeout=self.http_timeout
                )
                res.raise_for_status()
                logger.info(f"System Name is changed to {self.system_name} (fallback method).")
                return True
            except requests.exceptions.RequestException as e_fallback:
                logger.error(f"Fallback set system name failed: {e_fallback}")
                return False


    def _initialize_system(self):
        """Performs initial system setup (e.g., setting admin password)."""
        # This endpoint is typically for first-time setup.
        configuration_payload = {
            "name": self.system_name, # Initial system name
            "settings": {}, # Optional initial settings
            "local": {
                "password": self.local_admin_password # Sets local admin password
            }
        }
        try:
            logger.info(f"{self.system_name}: Attempting system initialization (set password, initial name).")
            res = self.session.post(
                f"{self.local_url}{SYSTEM_SETUP_PATH}",
                json=configuration_payload,
                verify=False, 
                timeout=self.http_timeout
            )
            # Could have :
            #
            # if not the fresh system:
            #     leave and exeucte the procedure of configuration udpate.
            # else:
            #    logger.info(f"{self.system_name}: System initialization call successful.")

        except requests.exceptions.RequestException as e:
            logger.warning(f"{self.system_name}: System initialization call failed: {e}")
            if hasattr(e, 'response') and e.response is not None:
                logger.debug(f"Status: {e.response.status_code}, Content: {e.response.content}")
        
        # From 6.0,x onward, i.e. /rest/v3
        # it is possible to initialize the system all in one for both settings and cloud connect.
        # setup_payload = {
        #     "name": self.system_name,
        #     "settings": {
        #         "autoDiscoveryEnabled": True,
        #         "cameraSettingsOptimization": True,
        #         "statisticsAllowed": True
        #     },
        #     // Response from "/cdb/systems/bind" or "/partners/api/v3/cloud_systems/"
        #     "cloud": {
        #         "systemId": jsonData["id"],
        #         "authKey": jsonData["authKey"],
        #         "owner": jsonData["ownerAccountEmail"]
        #     },
        #     "organizationId": ORGANIZATION_ID // if under an organization
        # }

    def _logout_current_session(self):
        try:
            res = self.session.delete(
                f"{self.local_url}{LOGIN_SESSIONS_PATH}/current",
                verify=False, 
                timeout=self.http_timeout
            )
            res.raise_for_status()
            logger.info(f"{self.system_name}: Successfully logged out current session.")
        except requests.exceptions.RequestException as e:
            logger.warning(f"{self.system_name}: Failed to logout current session: {e}")
            # No action requried. Session might be invalid or already closed.

    def setup_system(self) -> Dict[str, Any]:
        """
        Orchestrates the complete setup of the VMS system based on configuration.

        Returns:
            A dictionary summarizing the setup results.
        """
        logger.info(f"{self.system_name}: Starting system setup ==============")

        # Attempt initial login (e.g. with default "admin" password for initialization)
        # This is often needed to access the _initialize_system endpoint
        # if the system is in a factory default state.
        initial_auth_header = self.login("admin", "admin") # Try with common default "admin"/"admin"
        if not initial_auth_header:
             logger.info(f"{self.system_name}: Initial login failed, trying configured password.")
             # If default login fails, _initialize_system might still work or require no auth
             # or the system is already past this stage.
        
        self._initialize_system() # Sets/confirms local admin password
        self._logout_current_session() # Logout after initialization

        # Login with the configured local admin password for subsequent operations
        auth_header = self.login("admin", self.local_admin_password)
        if not auth_header:
            logger.critical(
                f"{self.system_name}: Failed to login with configured local admin password. "
                "Cannot proceed with setup."
            )
            return {
                "system_name": self.system_name,
                "error": "Login with configured local admin password failed.",
                "connect_to_cloud": STATE_UNKNOWN,
                "auto_discovery": STATE_UNKNOWN,
                "anonymous_statistics_report": STATE_UNKNOWN,
                "camera_optimization": STATE_UNKNOWN
            }

        current_system_settings = self.get_current_system_settings()

        # Cloud connection
        cloud_connect_status = self._setup_connect_to_cloud(
            current_system_settings.get("cloudSystemID")
        )

        # System name
        if current_system_settings.get("systemName") != self.system_name and \
           current_system_settings.get("systemName") != STATE_UNKNOWN:
            logger.info(
                f"{self.system_name}: Current name '{current_system_settings.get('systemName')}' "
                f"differs from desired '{self.system_name}'. Attempting update."
            )
            self._set_system_name()
        elif current_system_settings.get("systemName") == STATE_UNKNOWN:
             logger.info(f"{self.system_name}: System name is UNKNOWN." 
                         f"Attempting to set to '{self.system_name}'."
            )
             self._set_system_name()


        # Auto-discovery
        auto_discovery_status = self._setup_boolean_feature(
            settings_name="Auto Discovery",
            current_feature_state=current_system_settings["autoDiscoveryEnabled"],
            desired_enabled_state=self.enable_auto_discovery,
            configure_func=self._configure_auto_discovery
        )

        # Camera optimization
        camera_optimization_status = self._setup_boolean_feature(
            settings_name="Camera Optimization",
            current_feature_state=current_system_settings["cameraSettingsOptimization"],
            desired_enabled_state=self.enable_camera_optimization,
            configure_func=self._configure_camera_optimization
        )

        # Anonymous statistics report
        anonymous_statistics_report_status = self._setup_boolean_feature(
            settings_name="Anonymous Statistics Report",
            current_feature_state=current_system_settings["statisticsAllowed"],
            desired_enabled_state=self.allow_anonymous_statistics_report,
            configure_func=self._configure_anonymous_statistics_report
        )

        self._logout_current_session() # Logout at the end of operations

        logger.info(f"{self.system_name}: System setup process finished.")
        return {
            "system_name": self.system_name,
            "connect_to_cloud": cloud_connect_status,
            "auto_discovery": auto_discovery_status,
            "anonymous_statistics_report": anonymous_statistics_report_status,
            "camera_optimization": camera_optimization_status
        }


#if __name__ == '__main__':
    # This is an example of how VmsSystem might be used.
    # Replace 'path/to/your/config.ini' with the actual path.
    # Ensure cloud_hosts.json is in the same directory or adjust path.
    # try:
    #     # Example: Create a dummy config file for testing
    #     dummy_config_path = "dummy_config.ini"
    #     parser = configparser.ConfigParser()
    #     parser["server"] = {
    #         "ip_address": "127.0.0.1",
    #         "port": "7001",
    #         "system_name": "TestVMSSystem",
    #         "local_admin_password": "newpassword"
    #     }
    #     parser["system_settings"] = {
    #         "product": "MyVMSProduct", # Ensure this matches a product in cloud_hosts.json
    #         "connect_to_cloud": "False",
    #         "enable_auto_discovery": "True",
    #         "allow_anonymous_statistics_report": "True",
    #         "enable_camera_optimization": "False"
    #     }
    #     parser["cloud"] = {
    #         "cloud_account": "user@example.com",
    #         "cloud_password": "cloudpassword",
    #         "connect_to_organization": "False",
    #         # "organization_id": "" # if connect_to_organization is True
    #     }
    #     with open(dummy_config_path, 'w') as configfile:
    #         parser.write(configfile)

    #     # Example: Create a dummy cloud_hosts.json
    #     dummy_cloud_hosts = {
    #         "data": [
    #             {
    #                 "MyVMSProduct": {
    #                     "cloud_host": "mycloud.example.com", 
    #                     "customization": "mybrand"
    #                 }
    #             }
    #         ]
    #     }
    #     with open("cloud_hosts.json", 'w') as f:
    #         json.dump(dummy_cloud_hosts, f)
        
    #     print(f"Attempting to initialize VmsSystem with {dummy_config_path}")
    #     vms = VmsSystem(dummy_config_path)
    #     print("VmsSystem initialized. Running setup_system...")
    #     results = vms.setup_system()
    #     print("setup_system completed. Results:")
    #     print(json.dumps(results, indent=2))
    # except Exception as e:
    #     print(f"An error occurred in the example usage: {e}")
    #     logger.exception("Error in __main__ example usage")

    # #print("VmsSystem class definition is complete.") 
    # print("Uncomment and adapt the __main__ block for further testing or trail.")