// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "object_tracker.h"

#include <opencv2/core/core.hpp>

#include "exceptions.h"

namespace sample_company {
namespace vms_server_plugins {
namespace opencv_object_detection {

using namespace std::string_literals;

using namespace cv;
using namespace cv::detail::tracking::tbm;

using namespace nx::sdk;
using namespace nx::sdk::analytics;

/**
 * This function implementation is based on the sample from opencv_contrib repository:
 * https://github.com/opencv/opencv_contrib/blob/0a2179b328/modules/tracking/samples/tracking_by_matching.cpp
 */
cv::Ptr<ITrackerByMatching> createTrackerByMatchingWithFastDescriptor()
{
    TrackerParams params;

    // Real forget delay will be `params.forget_delay * kDetectionFramePeriod`.
    params.forget_delay = 75;

    cv::Ptr<ITrackerByMatching> tracker = createTrackerByMatching(params);

    static const Size kDescriptorFastSize(16, 32);
    std::shared_ptr<IImageDescriptor> descriptorFast =
        std::make_shared<ResizedImageDescriptor>(
            kDescriptorFastSize, InterpolationFlags::INTER_LINEAR);
    std::shared_ptr<IDescriptorDistance> distanceFast =
        std::make_shared<MatchTemplateDistance>();

    tracker->setDescriptorFast(descriptorFast);
    tracker->setDistanceFast(distanceFast);

    return tracker;
}

//-------------------------------------------------------------------------------------------------
// public

ObjectTracker::ObjectTracker():
    m_tracker(createTrackerByMatchingWithFastDescriptor())
{
}

DetectionList ObjectTracker::run(
    const Frame& frame,
    const DetectionList& detections)
{
    try
    {
        return runImpl(frame, detections);
    }
    catch (const cv::Exception& e)
    {
        throw ObjectTrackingError(cvExceptionToStdString(e));
    }
    catch (const std::exception& e)
    {
        throw ObjectTrackingError("Error: "s + e.what());
    }
}

//-------------------------------------------------------------------------------------------------
// private

DetectionList ObjectTracker::runImpl(
    const Frame& frame,
    const DetectionList& detections)
{
    // Unfortunately the OpenCV tbm module does not support preserving classLabel during tracking.
    // See issue: https://github.com/opencv/opencv_contrib/issues/2298
    // Therefore, we save information about classLabels in the map from unique id of the detection
    // (bounding box + timestamp) to classLabel.
    std::map<const CompositeDetectionId, std::string> classLabels;

    TrackedObjects detectionsToTrack = convertDetectionsToTrackedObjects(
        /*frame*/ frame,
        /*detections*/ detections,
        /*classLabels*/ &classLabels);

    // Perform tracking and extract tracked detections.
    m_tracker->process(frame.cvMat, detectionsToTrack, (uint64_t) frame.timestampUs);
    const TrackedObjects trackedDetections = m_tracker->trackedDetections();

    DetectionList result = convertTrackedObjectsToDetections(
        /*frame*/ frame,
        /*trackedDetections*/ trackedDetections,
        /*classLabels*/ classLabels,
        /*idMapper*/ m_idMapper.get());

    cleanupIds();

    return result;
}

/**
 * Cleanup ids of the objects that belong to the forgotten tracks.
 */
void ObjectTracker::cleanupIds()
{
    std::set<int64_t> validIds;
    for (const auto& track: m_tracker->tracks())
        validIds.insert(track.second.first_object.object_id);
    m_idMapper->removeAllExcept(validIds);
}

} // namespace opencv_object_detection
} // namespace vms_server_plugins
} // namespace sample_company
