// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <chrono>
#include <memory>
#include <vector>

#include <nx/sdk/analytics/rect.h>
#include <nx/sdk/uuid.h>

#include "geometry.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

struct Detection
{
    Rect boundingBox = {{-1, -1}, {-1, -1}};
    float confidence = 0;
    nx::sdk::Uuid trackId;
    int64_t timestampUs = 0;
};

using DetectionConstPtr = std::shared_ptr<const Detection>;
using DetectionPtr = std::shared_ptr<Detection>;
using DetectionList = std::vector<DetectionPtr>;

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
