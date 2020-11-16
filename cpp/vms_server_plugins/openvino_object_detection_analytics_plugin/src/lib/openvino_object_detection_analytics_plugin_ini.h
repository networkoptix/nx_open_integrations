// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <nx/kit/ini_config.h>

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

struct Ini: public nx::kit::IniConfig
{
    Ini(): IniConfig("openvino_object_detection_analytics_plugin.ini") { reload(); }

    NX_INI_FLAG(1, enableOutput, "");
};

inline Ini& ini()
{
    static Ini ini;
    return ini;
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
