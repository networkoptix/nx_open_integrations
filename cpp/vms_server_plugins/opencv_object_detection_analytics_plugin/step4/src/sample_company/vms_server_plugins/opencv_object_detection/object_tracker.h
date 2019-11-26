// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <algorithm>
#include <map>

#include <opencv2/tracking/tracking_by_matching.hpp>

#include <nx/sdk/helpers/uuid_helper.h>
#include <nx/sdk/uuid.h>

#include "detection.h"
#include "frame.h"
#include "object_tracker_utils.h"

namespace sample_company {
namespace vms_server_plugins {
namespace opencv_object_detection {

using namespace std::chrono_literals;

class ObjectTracker
{
public:
    ObjectTracker();

    DetectionList run(const Frame& frame, const DetectionList& detections);

private:
    DetectionList runImpl(
        const Frame& frame,
        const DetectionList& detections);

    void cleanupIds();

private:
    const cv::Ptr<cv::tbm::ITrackerByMatching> m_tracker;
    const std::unique_ptr<IdMapper> m_idMapper = std::make_unique<IdMapper>();
};

} // namespace opencv_object_detection
} // namespace vms_server_plugins
} // namespace sample_company
