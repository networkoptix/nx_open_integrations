// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

enum class Status
{
    inactive,
    started,
    active,
    finished
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
