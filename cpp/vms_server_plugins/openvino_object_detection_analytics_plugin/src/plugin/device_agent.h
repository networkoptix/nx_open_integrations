// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <string>
#include <vector>

#define NX_PRINT_PREFIX (this->logUtils.printPrefix)
#include <nx/kit/debug.h>
#include <nx/kit/utils.h>
#include <nx/sdk/analytics/i_metadata_packet.h>
#include <nx/sdk/analytics/helpers/consuming_device_agent.h>
#include <nx/sdk/analytics/helpers/event_metadata.h>
#include <nx/sdk/analytics/helpers/event_metadata_packet.h>
#include <nx/sdk/analytics/helpers/object_track_best_shot_packet.h>
#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/analytics/helpers/object_metadata_packet.h>
#include <nx/sdk/helpers/media_stream_statistics.h>

#include "engine.h"
#include "lib/config.h"
#include "lib/object_detection_processor.h"
#include "lib/openvino_object_detection_analytics_plugin_ini.h"
#include "lib/utils.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {
    
using MetadataPacketList = std::vector<nx::sdk::Ptr<nx::sdk::analytics::IMetadataPacket>>;

class DeviceAgent: public nx::sdk::analytics::ConsumingDeviceAgent
{
public:
    DeviceAgent(Engine* engine, const nx::sdk::IDeviceInfo* deviceInfo) noexcept;
    virtual ~DeviceAgent() noexcept override = default;

protected:
    virtual std::string manifestString() const noexcept override;
    virtual nx::sdk::Result<const nx::sdk::ISettingsResponse*> settingsReceived() override;
    virtual bool pushUncompressedVideoFrame(
        const nx::sdk::analytics::IUncompressedVideoFrame* videoFrame) noexcept override;
    virtual void doSetNeededMetadataTypes(
        nx::sdk::Result<void>* outValue,
        const nx::sdk::analytics::IMetadataTypes* neededMetadataTypes) override;

private:
    bool needToDetectObjects(
        const sdk::analytics::IUncompressedVideoFrame *nxFrame) const noexcept;

    int calcObjectDetectionPeriod() const;
    void pushMetadataPackets(const MetadataPacketList& metadataPackets);
    void updateConfigOnFpsChange(const Frame &frame);
    void processFrame(const nx::sdk::analytics::IUncompressedVideoFrame* nxFrame) noexcept;
    void parseSettings() noexcept;
    RoiLineList parseLinesSettings();
    RoiAreaList parseAreasSettings();

private:
    Engine* const m_engine = nullptr;

    std::unique_ptr<ObjectDetectionProcessor> m_objectDetectionProcessor;
    const std::unique_ptr<nx::sdk::MediaStreamStatistics> m_mediaStreamStatistics =
        std::make_unique<nx::sdk::MediaStreamStatistics>();
    std::shared_ptr<const Config> m_config;
    bool m_terminated = false;
    int64_t m_frameIndex = -1;
    bool m_terminatedPrevious = false;
    float m_fps = 30.0F;
    int m_detectionFrequencyFps = 5;
    bool m_isExponentialBackoffActive = false; //< When no detection were found set it to true.
    int64_t m_fpsChangeTimestampUs = 0;
    float m_exponentialBackoffObjectDetectionPeriod = m_fps / m_detectionFrequencyFps;

    static constexpr int m_maxExponentialBackoffObjectDetectionPeriod = 1024;
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
