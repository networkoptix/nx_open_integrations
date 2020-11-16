// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <algorithm>
#include <map>
#include <vector>
#include <optional>

#include <filesystem>

#include <opencv2/core/mat.hpp>

#include <opencv_tbm/tracking_by_matching.hpp>

#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/analytics/rect.h>
#include <nx/sdk/helpers/log_utils.h>
#include <nx/sdk/helpers/uuid_helper.h>
#include <nx/sdk/uuid.h>

#include "config.h"
#include "detection.h"
#include "event.h"
#include "frame.h"
#include "geometry.h"
#include "object_tracker_utils.h"
#include "person_re_id.h"
#include "track.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace std::chrono_literals;

class PersonTracker
{
public:
    struct Result
    {
        BestShotList bestShots;
        DetectionList detections;
        EventList events;
        TrackList tracks;
    };

public:
    PersonTracker(
        std::filesystem::path modelDir,
        nx::sdk::LogUtils logUtils,
        const std::shared_ptr<const Config>& config);

    void setConfig(const std::shared_ptr<const Config> config, bool updateFpsOnly = false);
    Result run(const Frame& frame, const DetectionList& detections);

private:
    class PersonReIdDescriptor: public cv::tbm::IImageDescriptor
    {
    public:
        PersonReIdDescriptor(
            std::filesystem::path modelDir,
            nx::sdk::LogUtils logUtils,
            const std::shared_ptr<const Config> config);

        virtual cv::Size size() const override;

        virtual void compute(const cv::Mat &mat, CV_OUT cv::Mat& descriptor) override;

        virtual void compute(
            const std::vector<cv::Mat> &mats,
            CV_OUT std::vector<cv::Mat>& descriptors) override;

    private:
        std::shared_ptr<PersonReId> m_personReId;
    };

private:
    Result runImpl(const Frame& frame, const DetectionList& detections);
    std::shared_ptr<Track> getOrCreateTrack(const nx::sdk::Uuid& trackId);
    void copyDetectionsHistoryToTrack(const Frame& frame, int64_t cvTrackId, Track* track) const;
    void processDetection(const Frame& frame, const std::shared_ptr<DetectionInternal>& detection);
    void processDetections(const Frame& frame, const DetectionInternalList& detectionsInternal);
    EventList generateEvents();
    void cleanupIds();
    void cleanupTracks();
    void cleanup();
    cv::Ptr<cv::tbm::ITrackerByMatching> createPersonTrackerByMatching(int forgetDelay);
    void finishTracks();
    TrackList extractTracks() const;
    BestShotList extractBestShots() const;

private:
    nx::sdk::LogUtils logUtils;
    std::filesystem::path m_modelDir;
    std::shared_ptr<PersonReIdDescriptor> m_personReIdDescriptor;
    cv::Ptr<cv::tbm::ITrackerByMatching> m_tracker;
    std::unique_ptr<IdMapper> m_idMapper = std::make_unique<IdMapper>();
    TrackMap m_tracks;
    std::optional<int64_t> m_personDetectionStartTimestampUs;
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
