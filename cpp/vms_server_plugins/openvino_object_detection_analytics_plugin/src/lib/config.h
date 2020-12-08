// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <chrono>
#include <vector>

#include "geometry.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace std::chrono_literals;

struct Config
{
    struct Default
    {
        // All "magic" constants were empirically chosen and probably wouldn't work good for all
        // customers.
        static constexpr float kMinDetectionConfidence = 0.75F;
        static constexpr int kThreadCount = 0; //< Zero means using all logical CPU cores.
        static constexpr int kDetectionFrequencyFps = 5;
        static constexpr float kMinReIdCosineSimilarity = 0.5F;
        static constexpr std::chrono::seconds kMinIntervalBetweenTracks = 5s;
    };

    float minDetectionConfidence = Default::kMinDetectionConfidence;
    int threadCount = Default::kThreadCount;
    int objectDetectionPeriod = Default::kDetectionFrequencyFps;
    float minReIdCosineSimilarity = Default::kMinReIdCosineSimilarity;
    std::chrono::seconds minIntervalBetweenTracks = Default::kMinIntervalBetweenTracks;
    float fps = 0;
    RoiLineList lines;
    RoiAreaList areas;

    inline int minFrameCountIntervalBetweenTracks() const
    {
        return (int) (fps * minIntervalBetweenTracks.count());
    }
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
