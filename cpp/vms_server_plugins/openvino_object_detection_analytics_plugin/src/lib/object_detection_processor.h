// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <filesystem>

#include <opencv2/core/mat.hpp>

#include <nx/sdk/analytics/helpers/object_metadata.h> //< TODO: Remove the dependency.
#include <nx/sdk/helpers/log_utils.h>

#include "config.h"
#include "object_detector.h"
#include "openvino_log_utils.h"
#include "roi_processor.h"
#include "track.h"
#include "status.h"
#include "frame.h"
#include "person_tracker.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

class ObjectDetectionProcessor
{
public:
    struct Result
    {
        BestShotList bestShots;
        DetectionList detections;
        EventList events;
        RoiProcessor::Result roiEvents;
    };

public:
    ObjectDetectionProcessor (
        const std::filesystem::path& modelDir,
        nx::sdk::LogUtils logUtils,
        const std::shared_ptr<const Config>& config = std::make_shared<const Config>());

    Result run(const Frame& frame, bool needToDetectObjects);
    void setConfig(const std::shared_ptr<const Config> config);
    void setFps(float fps);
    bool isTerminated() const { return m_terminated; };
    void reinitializeObjectTrackerOnFrameSizeChanges(const Frame &frame);

protected:
    nx::sdk::LogUtils logUtils;

private:
    std::unique_ptr<ObjectDetector> m_objectDetector;
    std::unique_ptr<PersonTracker> m_personTracker;
    std::unique_ptr<RoiProcessor> m_roiProcessor;
    std::shared_ptr<const Config> m_config;
    std::filesystem::path m_modelDir;
    bool m_terminated = false;

    // Used for checking whether the frame size changed, and for reinitializing the tracker.
    int m_previousFrameWidth = 0;
    int m_previousFrameHeight = 0;
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
