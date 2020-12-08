// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <memory>
#include <vector>

#include <nx/sdk/uuid.h>

#include "geometry.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

struct BestShot
{
    Rect boundingBox = {{-1, -1}, {-1, -1}};
    float confidence = 0;
    int64_t timestampUs = 0;
    nx::sdk::Uuid trackId;
};

using BestShotPtr = std::shared_ptr<BestShot>;
using BestShotList = std::vector<BestShotPtr>;

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
