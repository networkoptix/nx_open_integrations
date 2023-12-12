// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <algorithm>
#include <map>

#include <opencv2/tracking/tracking_by_matching.hpp>

#include <nx/sdk/helpers/uuid_helper.h>
#include <nx/sdk/uuid.h>

#include "detection.h"
#include "frame.h"
#include "event.h"
#include "object_tracker_utils.h"

namespace sample_company {
namespace vms_server_plugins {
namespace opencv_object_detection {

using namespace std::chrono_literals;

using EventList = std::vector<std::shared_ptr<Event>>;

class ObjectTracker
{
public:
    struct Result
    {
        DetectionList detections;
        EventList events;
    };

public:
    ObjectTracker();

    Result run(const Frame& frame, const DetectionList& detections);

private:
    class Track;

    EventList generateDetectionFinishedEvents(int64_t timestampUs);

    void copyDetectionsHistoryToTrack(
        const Frame& frame,
        int64_t cvTrackId,
        Track* track,
        const std::string& classLabel) const;

    std::shared_ptr<Track> getOrCreateTrack(const nx::sdk::Uuid& trackId);

    EventList processDetection(
        const Frame& frame,
        const std::shared_ptr<DetectionInternal>& detection);

    EventList generateEvents(
        const Frame& frame,
        const DetectionInternalList& detectionsInternal);

    Result runImpl(
        const Frame& frame,
        const DetectionList& detections);

    void cleanupIds();
    void cleanupTracks();
    void cleanup();

private:
    const cv::Ptr<cv::detail::tracking::tbm::ITrackerByMatching> m_tracker;
    const std::unique_ptr<IdMapper> m_idMapper{new IdMapper()};
    std::map</*trackId*/ const nx::sdk::Uuid, /*track*/ std::shared_ptr<Track>> m_tracks;
    std::map</*classLabel*/ const std::string, /*detectionActive*/ bool> m_detectionActive;
};

} // namespace opencv_object_detection
} // namespace vms_server_plugins
} // namespace sample_company
