// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "object_detection_processor.h"

#include <vector>

#define NX_PRINT_PREFIX (this->logUtils.printPrefix)
#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/helpers/log_utils.h>

#include "config.h"
#include "exceptions.h"
#include "roi_processor.h"
#include "track.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace std::string_literals;

using namespace nx::sdk;
using namespace nx::sdk::analytics;

ObjectDetectionProcessor::ObjectDetectionProcessor(
    const std::filesystem::path& modelDir,
    LogUtils logUtils,
    const std::shared_ptr<const Config>& config)
    :
    m_config(config),
    m_modelDir(modelDir),
    logUtils(logUtils),
    m_objectDetector(std::make_unique<ObjectDetector>(modelDir, logUtils, config)),
    m_personTracker(std::make_unique<PersonTracker>(modelDir, logUtils, config)),
    m_roiProcessor(std::make_unique<RoiProcessor>(logUtils, config))
{
}

ObjectDetectionProcessor::Result ObjectDetectionProcessor::run(
    const Frame& frame,
    bool needToDetectObjects)
{
    if (m_terminated)
        return {};

    Result result;

    reinitializeObjectTrackerOnFrameSizeChanges(frame);

    DetectionList detections;
    if (needToDetectObjects)
    {
        try
        {
            detections = m_objectDetector->run(frame);
        }
        catch (const ObjectDetectionError& e)
        {
            m_terminated = true;
            throw FrameProcessingError("Object detection error: "s + e.what());
        }
    }

    PersonTracker::Result trackerResult;
    try
    {
        trackerResult = m_personTracker->run(frame, detections);
    }
    catch (const ObjectTrackingError& e)
    {
        m_terminated = true;
        throw FrameProcessingError("Object tracking error: "s + e.what());
    }

    RoiProcessor::Result roiEvents;
    try
    {
        roiEvents = m_roiProcessor->run(
            trackerResult.tracks,
            trackerResult.events,
            !needToDetectObjects);
    }
    catch (const RoiError &e)
    {
        m_terminated = true;
        throw FrameProcessingError("Regions of interests error: "s + e.what());
    }

    return {
        trackerResult.bestShots,
        trackerResult.detections,
        trackerResult.events,
        roiEvents,
    };
}

void ObjectDetectionProcessor::setConfig(const std::shared_ptr<const Config> config)
{
    m_config = config;
    m_objectDetector->setConfig(config);
    m_personTracker->setConfig(config);
    m_roiProcessor->setConfig(config);
}

void ObjectDetectionProcessor::reinitializeObjectTrackerOnFrameSizeChanges(const Frame& frame)
{
    const bool frameSizeUnset = m_previousFrameWidth == 0 && m_previousFrameHeight == 0;
    if (frameSizeUnset)
    {
        m_previousFrameWidth = frame.width;
        m_previousFrameHeight = frame.height;
        return;
    }

    const bool frameSizeChanged = frame.width != m_previousFrameWidth ||
        frame.height != m_previousFrameHeight;
    if (frameSizeChanged)
    {
        m_personTracker = std::make_unique<PersonTracker>(m_modelDir, logUtils, m_config);
        m_previousFrameWidth = frame.width;
        m_previousFrameHeight = frame.height;
    }
}

void ObjectDetectionProcessor::setFps(float fps)
{
    Config newConfig(*m_config);
    newConfig.fps = fps;
    m_config = std::make_shared<const Config>(newConfig);
    m_personTracker->setConfig(m_config, /*updateFpsOnly*/ true);
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
