// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <filesystem>

#include <nx/sdk/analytics/helpers/event_metadata_packet.h>
#include <nx/sdk/analytics/helpers/object_metadata_packet.h>
#include <nx/sdk/analytics/helpers/consuming_device_agent.h>
#include <nx/sdk/helpers/uuid_helper.h>
#include <nx/sdk/ptr.h>

#include "engine.h"
#include "object_detector.h"
#include "object_tracker.h"

namespace sample_company {
namespace vms_server_plugins {
namespace opencv_object_detection {

class DeviceAgent: public nx::sdk::analytics::ConsumingDeviceAgent
{
public:
    using MetadataPacketList = std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>>;

public:
    DeviceAgent(
        const nx::sdk::IDeviceInfo* deviceInfo,
        std::filesystem::path pluginHomeDir);

    virtual ~DeviceAgent() override;

protected:
    virtual std::string manifestString() const override;

    virtual bool pushUncompressedVideoFrame(
        const nx::sdk::analytics::IUncompressedVideoFrame* videoFrame) override;

    virtual void doSetNeededMetadataTypes(
        nx::sdk::Result<void>* outValue,
        const nx::sdk::analytics::IMetadataTypes* neededMetadataTypes) override;

private:
    void reinitializeObjectTrackerOnFrameSizeChanges(const Frame& frame);

    nx::sdk::Ptr<nx::sdk::analytics::ObjectMetadataPacket> detectionsToObjectMetadataPacket(
        const DetectionList& detections,
        int64_t timestampUs);

    MetadataPacketList eventsToEventMetadataPacketList(
        const EventList& events,
        int64_t timestampUs);

    MetadataPacketList processFrame(
        const nx::sdk::analytics::IUncompressedVideoFrame* videoFrame);

private:
    const std::string kPersonObjectType = "nx.base.Person";
    const std::string kCatObjectType = "nx.base.Cat";
    const std::string kDogObjectType = "nx.base.Dog";

    const std::string kDetectionEventType = "sample.opencv_object_detection.detection";
    const std::string kDetectionEventCaptionSuffix = " detected";
    const std::string kDetectionEventDescriptionSuffix = " detected";

    const std::string kProlongedDetectionEventType =
        "sample.opencv_object_detection.prolongedDetection";

    /** Should work on modern PCs. */
    static constexpr int kDetectionFramePeriod = 2;

private:
    bool m_terminated = false;
    bool m_terminatedPrevious = false;
    const std::unique_ptr<ObjectDetector> m_objectDetector;
    std::unique_ptr<ObjectTracker> m_objectTracker;
    int m_frameIndex = 0; /**< Used for generating the detection in the right place. */

    // Used for checking whether the frame size changed, and for reinitializing the tracker.
    int m_previousFrameWidth = 0;
    int m_previousFrameHeight = 0;
};

} // namespace opencv_object_detection
} // namespace vms_server_plugins
} // namespace sample_company
