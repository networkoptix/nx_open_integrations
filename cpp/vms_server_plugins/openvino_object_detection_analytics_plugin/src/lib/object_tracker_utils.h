//// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <opencv_tbm/tracking_by_matching.hpp>

#include "detection.h"
#include "frame.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

/**
 * Provides conversion from int ids coming from the tracker to Uuid ids that are needed by the
 * Server.
 */
class IdMapper
{
public:
    nx::sdk::Uuid get(int64_t id);
    void removeAllExcept(const std::set<nx::sdk::Uuid>& idsToKeep);

private:
    std::map<int64_t, nx::sdk::Uuid> m_map;
};

struct DetectionInternal
{
    DetectionPtr detection;
    int64_t cvTrackId;
};

using DetectionInternalPtr = std::shared_ptr<DetectionInternal>;
using DetectionInternalList = std::vector<DetectionInternalPtr>;

DetectionInternalPtr convertTrackedObjectToDetection(
    const Frame& frame,
    const cv::tbm::TrackedObject& trackedDetection,
    IdMapper* idMapper);

DetectionInternalList convertTrackedObjectsToDetections(
    const Frame& frame,
    const cv::tbm::TrackedObjects& trackedDetections,
    IdMapper* idMapper);

cv::tbm::TrackedObjects convertDetectionsToTrackedObjects(
    const Frame& frame,
    const DetectionList& detections);

DetectionList extractDetectionList(const DetectionInternalList& detectionsInternal);

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
