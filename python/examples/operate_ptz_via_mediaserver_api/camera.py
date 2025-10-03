#!/usr/bin/env python3
"""
Copyright © 2018–present Network Optix, Inc.  
Licensed under [MPL 2.0](https://www.mozilla.org/MPL/2.0/)

Camera module for managing PTZ-capable cameras and issuing PTZ commands via server API.

Defines:
- CameraSettings: Data structure holding camera attributes.
- Camera: Wrapper class for interacting with a specific camera.

"""

from dataclasses import dataclass
from typing import Union
import sys
import pathlib

# Add common path for server_api
sys.path += [f"{pathlib.Path(__file__).parent.resolve()}/../common"]
import server_api as api

# API version to use
API_VERSION = "v3"

# Bitmask definitions for PTZ capabilities
PTZ_CAPABILITIES = {
    'NoPtzCapabilities': 0,
    'ContinuousPanCapability': 1,
    'ContinuousTiltCapability': 2,
    'ContinuousZoomCapability': 4,
    'ContinuousFocusCapability': 8,
    'ContinuousRotationCapability': 536870912,
    'AbsolutePanCapability': 16,
    'AbsoluteTiltCapability': 32,
    'AbsoluteZoomCapability': 64,
    'AbsoluteRotationCapability': 1073741824,
    'RelativePanCapability': 1024,
    'RelativeTiltCapability': 2048,
    'RelativeZoomCapability': 16384,
    'RelativeRotationCapability': 32768,
    'RelativeFocusCapability': 8388608,
    'ViewportPtzCapability': 128,
    'FlipPtzCapability': 256,
    'LimitsPtzCapability': 512,
    'DevicePositioningPtzCapability': 4096,
    'LogicalPositioningPtzCapability': 8192,
    'PresetsPtzCapability': 65536,
    'ToursPtzCapability': 131072,
    'ActivityPtzCapability': 262144,
    'HomePtzCapability': 524288,
    'AsynchronousPtzCapability': 1048576,
    'SynchronizedPtzCapability': 2097152,
    'VirtualPtzCapability': 4194304,
    'AuxiliaryPtzCapability': 16777216,
    'NativePresetsPtzCapability': 134217728,
}


@dataclass
class CameraSettings:
    """Configuration object holding camera metadata and capabilities."""
    name: str
    camera_id: str
    manufacturer: str
    model: str
    ptz_capabilities: dict[str, Union[int, bool]]
    mac: str
    ip: str


class Camera:
    """
    Camera abstraction for interacting with PTZ features through the server API.
    """

    def __init__(self, camera_info: dict):
        self.settings = self._get_camera_settings(camera_info)

    # -----------------------
    # Camera Information Helpers
    # -----------------------

    @staticmethod
    def _parse_ptz_capabilities(cam: dict) -> dict[str, Union[int, bool]]:
        """Extract PTZ capabilities depending on API version."""
        if API_VERSION == "v3" and "ptzCapabilities" in cam.get("parameters", {}):
            value = cam["parameters"].get("ptzCapabilities", 0)
            if value == 0:
                return {"NoPtzCapabilities": True}
            return {name: True for name, bit in PTZ_CAPABILITIES.items() if value & bit}

        elif API_VERSION == "v4" and "ptz" in cam:
            caps_str = cam["ptz"].get("capabilities", "")
            return {cap: True for cap in caps_str.split("|") if cap}

        return {"NoPtzCapabilities": True}

    @classmethod
    def _get_camera_settings(cls, cam: dict) -> CameraSettings:
        """Convert raw camera info dict into CameraSettings."""
        return CameraSettings(
            name=cam.get("name", ""),
            camera_id=cam.get("camera_id", cam.get("id", "")),
            manufacturer=cam.get("vendor", ""),
            model=cam.get("model", ""),
            ptz_capabilities=cls._parse_ptz_capabilities(cam),
            mac=cam.get("mac", ""),
            ip=cam.get("url", ""),
        )

    # -----------------------
    # PTZ API Calls
    # -----------------------

    def ptz_move_start(self, server_url, camera_id, auth_header, request_body):
        """Start a PTZ continuous move."""
        api.request_api(
            server_url,
            f"/rest/{API_VERSION}/devices/{camera_id}/ptz/move",
            'POST',
            headers=auth_header,
            json=request_body,
            verify=False,
            allow_redirects=False,
        )

    def ptz_move_stop(self, server_url, camera_id, auth_header):
        """Stop a PTZ continuous move."""
        body = {"api": "operational"}
        api.request_api(
            server_url,
            f"/rest/{API_VERSION}/devices/{camera_id}/ptz/move",
            'DELETE',
            headers=auth_header,
            json=body,
            verify=False,
            allow_redirects=False,
        )

    def ptz_get_presets(self, server_url, camera_id, auth_header):
        """Retrieve PTZ presets."""
        return api.request_api(
            server_url,
            f"/rest/{API_VERSION}/devices/{camera_id}/ptz/presets",
            'GET',
            headers=auth_header,
            verify=False,
            allow_redirects=False,
        )

    def ptz_set_preset(self, server_url, camera_id, auth_header, request_body):
        """Save a new PTZ preset."""
        api.request_api(
            server_url,
            f"/rest/{API_VERSION}/devices/{camera_id}/ptz/presets",
            'POST',
            headers=auth_header,
            json=request_body,
            verify=False,
            allow_redirects=False,
        )

    def ptz_goto_preset(self, server_url, camera_id, auth_header, preset_id, request_body):
        """Go to a saved PTZ preset."""
        api.request_api(
            server_url,
            f"/rest/{API_VERSION}/devices/{camera_id}/ptz/presets/{preset_id}/activate",
            'POST',
            headers=auth_header,
            json=request_body,
            verify=False,
            allow_redirects=False,
        )

    def ptz_move_absolute(self, server_url, camera_id, auth_header, request_body):
        """Perform an absolute PTZ move."""
        api.request_api(
            server_url,
            f"/rest/{API_VERSION}/devices/{camera_id}/ptz/position",
            'POST',
            headers=auth_header,
            json=request_body,
            verify=False,
            allow_redirects=False,
        )

    def ptz_get_tours(self, server_url, camera_id, auth_header):
        """Retrieve PTZ tours."""
        return api.request_api(
            server_url,
            f"/rest/{API_VERSION}/devices/{camera_id}/ptz/tours",
            'GET',
            headers=auth_header,
            verify=False,
            allow_redirects=False,
        )

    def ptz_activate_tour(self, server_url, camera_id, tour_id, auth_header):
        """Activate a PTZ tour."""
        api.request_api(
            server_url,
            f"/rest/{API_VERSION}/devices/{camera_id}/ptz/tours/{tour_id}/active",
            'POST',
            headers=auth_header,
            verify=False,
            allow_redirects=False,
        )

    def ptz_stop_tour(self, server_url, camera_id, auth_header, request_body):
        """Stop a PTZ tour (alias for move_start)."""
        self.ptz_move_start(server_url, camera_id, auth_header, request_body)