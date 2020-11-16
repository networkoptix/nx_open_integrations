//// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "object_tracker_utils.h"

#include <nx/sdk/helpers/uuid_helper.h>
#include <opencv_tbm/tracking_by_matching.hpp>

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace cv;
using namespace cv::tbm;

using namespace nx::sdk;

Uuid IdMapper::get(int64_t id)
{
    const auto it = m_map.find(id);
    if (it == m_map.end())
    {
        Uuid result = UuidHelper::randomUuid();
        m_map[id] = result;
        return result;
    }
    return it->second;
}

void IdMapper::removeAllExcept(const std::set<Uuid>& idsToKeep)
{
    for (auto it = m_map.begin(); it != m_map.end();)
    {
        if (idsToKeep.find(it->second) == idsToKeep.end())
            it = m_map.erase(it);
        else
            ++it;
    }
}

/**
 * Convert detection from opencv::tbm format to the plugin format.
 */
DetectionInternalPtr convertTrackedObjectToDetection(
    const Frame& frame,
    const TrackedObject& trackedDetection,
    IdMapper* idMapper)
{
    const auto boundingBox = convertCvRectToBoostRect(
        trackedDetection.rect,
        frame.width,
        frame.height);
    auto detection = std::make_shared<Detection>(Detection{
        boundingBox,
        (float) trackedDetection.confidence,
        /*trackId*/ idMapper->get(trackedDetection.object_id),
        (int64_t) trackedDetection.timestamp,
    });
    return std::make_shared<DetectionInternal>(DetectionInternal{
        detection,
        /*cvTrackId*/ trackedDetection.object_id,
    });
}

/**
 * Convert detections from opencv::tbm format to the plugin format, restoring the classLabels.
 */
DetectionInternalList convertTrackedObjectsToDetections(
    const Frame& frame,
    const TrackedObjects& trackedDetections,
    IdMapper* idMapper)
{
    DetectionInternalList result;
    for (const cv::tbm::TrackedObject& trackedDetection: trackedDetections)
    {
        result.push_back(convertTrackedObjectToDetection(
            frame,
            trackedDetection,
            idMapper));
    }

    return result;
}

/**
 * Convert detections from the plugin format to the format of opencv::tbm.
 */
TrackedObjects convertDetectionsToTrackedObjects(
    const Frame& frame,
    const DetectionList& detections)
{
    TrackedObjects result;

    for (const std::shared_ptr<Detection>& detection: detections)
    {
        const cv::Rect cvRect = convertBoostRectToCvRect(
                detection->boundingBox, frame.width, frame.height);
        result.push_back(TrackedObject(
                /*rect*/ cvRect,
                /*confidence*/ detection->confidence,
                /*frame_idx*/ (int) frame.index,
                /*object_id*/ -1)); //< Placeholder, to be filled in PersonTracker::process().
    }

    return result;
}

DetectionList extractDetectionList(const DetectionInternalList& detectionsInternal)
{
    DetectionList result;
    for (const std::shared_ptr<DetectionInternal>& detection: detectionsInternal)
        result.push_back(detection->detection);
    return result;
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
