// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "device_agent.h"

#include <chrono>
#include <string>
#include <system_error>
#include <optional>

#include <boost/predef.h>
#include <filesystem>

#define NX_PRINT_PREFIX (this->logUtils.printPrefix)
#include <nx/kit/debug.h>
#include <nx/kit/json.h>
#include <nx/kit/utils.h>
#include <nx/sdk/helpers/error.h>
#include <nx/sdk/analytics/helpers/event_metadata.h>
#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/analytics/helpers/object_metadata_packet.h>
#include <nx/sdk/analytics/helpers/object_track_best_shot_packet.h>
#include <nx/sdk/analytics/i_motion_metadata_packet.h>

#include "engine.h"
#include "lib/config.h"
#include "lib/exceptions.h"
#include "lib/geometry.h"
#include "lib/openvino_object_detection_analytics_plugin_ini.h"
#include "lib/best_shot.h"
#include "lib/settings.h"

#if BOOST_OS_WINDOWS
    #define WIN32_LEAN_AND_MEAN
    #if _WIN32_WINNT < 0x0502
        #define _WIN32_WINNT 0x0502
    #endif
    #include <windows.h>
#endif

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

using namespace std::chrono;
using namespace std::string_literals;

namespace {
#if BOOST_OS_WINDOWS
    class DllDirectorySetter
    {
    public:
        explicit DllDirectorySetter(std::filesystem::path const& newPath)
        {
            std::wstring oldPath(MAX_PATH, L'\0');
            while (true)
            {
                std::size_t size = GetDllDirectoryW(oldPath.size(), oldPath.data());
                if (size == 0) {
                    if (DWORD errCode = GetLastError())
                        throw std::system_error(errCode, std::system_category(),
                            "GetDllDirectoryW failed");
                    break;
                }

                if (size <= oldPath.size())
                {
                    oldPath.resize(size);
                    m_oldPath = oldPath;
                    break;
                }

                oldPath.resize(size + 1);
            }

            if (!SetDllDirectoryW(newPath.c_str()))
                throw std::system_error(GetLastError(), std::system_category(),
                    "SetDllDirectoryW("s + newPath.string() + ") failed"s);
        }

        ~DllDirectorySetter() noexcept(false)
        {
            if (!SetDllDirectoryW(m_oldPath ? m_oldPath->c_str() : nullptr))
                throw std::system_error(GetLastError(), std::system_category(),
                    "SetDllDirectoryW("s + (m_oldPath ? m_oldPath->string() : "nullptr") + ") failed"s);
        }

    private:
        std::optional<std::filesystem::path> m_oldPath;
    };
#else
    class DllDirectorySetter
    {
    public:
        explicit DllDirectorySetter(std::filesystem::path const& /*newPath*/)
        {
        }
    };
#endif // BOOST_OS_WINDOWS
} // namespace

Ptr<ObjectMetadataPacket> convertDetectionsToObjectMetadataPacket(
    const DetectionList& detections,
    int64_t timestampUs)
{
    if (detections.empty())
        return nullptr;
    
    const auto objectMetadataPacket = makePtr<ObjectMetadataPacket>();
    
    for (const DetectionPtr& detection: detections)
    {
        const auto objectMetadata = makePtr<ObjectMetadata>();
        
        objectMetadata->setBoundingBox(convertBoostRectToNxRect(detection->boundingBox));
        objectMetadata->setConfidence(detection->confidence);
        objectMetadata->setTrackId(detection->trackId);
        objectMetadata->setTypeId(kPersonObjectType);
        
        objectMetadataPacket->addItem(objectMetadata.get()); 
    }
    objectMetadataPacket->setTimestampUs(timestampUs);
    
    return objectMetadataPacket;
}

MetadataPacketList convertBestShotsToMetadataPacketList(const BestShotList& bestShots)
{
    MetadataPacketList result;
    for (const std::shared_ptr<BestShot>& bestShot: bestShots)
    {
        auto objectTrackBestShotPacket = makePtr<ObjectTrackBestShotPacket>(
            bestShot->trackId,
            bestShot->timestampUs,
            convertBoostRectToNxRect(bestShot->boundingBox)
        );
        result.push_back(objectTrackBestShotPacket);
    }
    return result;
}

MetadataPacketList convertEventsToEventMetadataPackets(const EventList& events)
{
    if (events.empty())
        return {};

    MetadataPacketList eventMetadataPackets;

    for (const EventPtr& event: events)
    {
        const auto eventMetadataPacket = makePtr<EventMetadataPacket>();
        const auto eventMetadata = makePtr<EventMetadata>();

        eventMetadata->setCaption(event->caption());
        eventMetadata->setDescription(event->description());
        eventMetadata->setTypeId(event->type());
        eventMetadata->setIsActive(event->isActive);

        eventMetadataPacket->addItem(eventMetadata.get());
        eventMetadataPacket->setTimestampUs(event->timestampUs);

        eventMetadataPackets.push_back(eventMetadataPacket);
    }

    return eventMetadataPackets;
}

MetadataPacketList convertObjectDetectionResultToMetadataPacketList(
    const ObjectDetectionProcessor::Result& objectDetectionResult,
    int64_t timestampUs)
{
    MetadataPacketList result;
    
    const Ptr<IMetadataPacket> objectMetadataPacket = convertDetectionsToObjectMetadataPacket(
        objectDetectionResult.detections,
        timestampUs);
    if (objectMetadataPacket)
        result.push_back(objectMetadataPacket);
    
    const MetadataPacketList objectTrackBestShotPackets = convertBestShotsToMetadataPacketList(
        objectDetectionResult.bestShots);
    result.insert(
        result.end(),
        std::make_move_iterator(objectTrackBestShotPackets.begin()),
        std::make_move_iterator(objectTrackBestShotPackets.end()));

    const MetadataPacketList eventMetadataPackets = convertEventsToEventMetadataPackets(
        objectDetectionResult.events);
    result.insert(
        result.end(),
        std::make_move_iterator(eventMetadataPackets.begin()),
        std::make_move_iterator(eventMetadataPackets.end()));

    const MetadataPacketList roiEventMetadataPackets = convertEventsToEventMetadataPackets(
        objectDetectionResult.roiEvents);
    result.insert(
        result.end(),
        std::make_move_iterator(roiEventMetadataPackets.begin()),
        std::make_move_iterator(roiEventMetadataPackets.end()));

    return result;
}

//-------------------------------------------------------------------------------------------------
// public

DeviceAgent::DeviceAgent(Engine* engine, const nx::sdk::IDeviceInfo* deviceInfo) noexcept
    :
    ConsumingDeviceAgent(deviceInfo, NX_DEBUG_ENABLE_OUTPUT),
    m_engine(engine)
{
}

std::string DeviceAgent::manifestString() const noexcept
{
    using nx::kit::Json;
    Json manifestJson = Json::object {
        { "eventTypes", Json::array {
            Json::object {
                { "id", PersonDetected::kType },
                { "name", PersonDetected::kName },
            },
            Json::object {
                { "id", PersonLost::kType },
                { "name", PersonLost::kName },
            },
            Json::object {
                { "id", PeopleDetected::kType },
                { "name", PeopleDetected::kName },
                { "flags", "stateDependent" },
            },
            Json::object {
                { "id", LineCrossed::kType },
                { "name", LineCrossed::kName },
            },
            Json::object {
                { "id", AreaCrossed::kType },
                { "name", AreaCrossed::kName },
            },
            Json::object {
                { "id", AreaEntranceDetected::kType },
                { "name", AreaEntranceDetected::kName },
            },
            Json::object {
                { "id", AreaExitDetected::kType },
                { "name", AreaExitDetected::kName },
            },
            Json::object {
                { "id", AppearanceInAreaDetected::kType },
                { "name", AppearanceInAreaDetected::kName },
            },
            Json::object {
                { "id", DisappearanceInAreaDetected::kType },
                { "name", DisappearanceInAreaDetected::kName },
            },
            Json::object {
                { "id", Loitering::kType },
                { "name", Loitering::kName },
                { "flags", "stateDependent" },
            },
        } },
        { "objectTypes", Json::array {
            Json::object {
                { "id", kPersonObjectType },
                { "name", kPersonObjectName },
            },
        } },
    };
    return manifestJson.dump();
}

Result<const ISettingsResponse*> DeviceAgent::settingsReceived()
{
    try {
        DllDirectorySetter dllDirecorySetter(m_engine->pluginHomeDir());
        parseSettings();
    } catch (std::exception const &e) {
        return error(ErrorCode::internalError, e.what());
    }
    return nullptr;
}

bool DeviceAgent::pushUncompressedVideoFrame(const IUncompressedVideoFrame* videoFrame) noexcept
{
    if (!m_config)
        return true;

    m_terminated = m_terminated || m_objectDetectionProcessor->isTerminated();
    if (m_terminated)
    {
        if (!m_terminatedPrevious)
        {
            pushPluginDiagnosticEvent(
                IPluginDiagnosticEvent::Level::error,
                "Plugin is in broken state.",
                "Disable the plugin.");
            m_terminatedPrevious = true;
        }
        return true;
    }

    using namespace std::chrono;
    const auto startTime = high_resolution_clock::now();

    processFrame(videoFrame);

    const auto finishTime = high_resolution_clock::now();
    const auto duration = duration_cast<milliseconds>(finishTime - startTime);
    NX_OUTPUT << "Frame processing duration: " << duration.count() << " ms.";

    return true;
}

//-------------------------------------------------------------------------------------------------
// private

void DeviceAgent::pushMetadataPackets(const MetadataPacketList& metadataPackets)
{
    for (const Ptr<IMetadataPacket>& metadataPacket: metadataPackets)
    {
        metadataPacket->addRef();
        pushMetadataPacket(metadataPacket.get());
    }
}

bool DeviceAgent::needToDetectObjects(const IUncompressedVideoFrame *nxFrame) const noexcept
{
    if (m_frameIndex % m_config->objectDetectionPeriod > 0)
        return false;

    if (m_isExponentialBackoffActive &&
        m_frameIndex % (int) m_exponentialBackoffObjectDetectionPeriod == 0)
        return true;

    const Ptr<IList<IMetadataPacket>> metadataPacketList = nxFrame->metadataList();
    if (!metadataPacketList)
        return false;

    const int metadataPacketCount = metadataPacketList->count();
    if (metadataPacketCount == 0)
        return false;

    for (int i = 0; i < metadataPacketCount; ++i)
    {
        const auto metadataPacket = metadataPacketList->at(i);
        const auto motionPacket = metadataPacket->queryInterface<IMotionMetadataPacket>();
        if (motionPacket)
            return !motionPacket->isEmpty();
    }

    return false;
}

void DeviceAgent::updateConfigOnFpsChange(const Frame& frame)
{
    m_mediaStreamStatistics->onData(microseconds(frame.timestampUs), 0, true);
    const float fps = m_mediaStreamStatistics->getFrameRate();
    static const float kFpsChangeFpsDifferenceThreshold = 0.10F;
    static const int64_t kFpsChangeTimestampUsDifferenceThreshold = 5000000;
    if (fps > 0 &&
        fabs(fps - m_fps) / m_fps > kFpsChangeFpsDifferenceThreshold &&
        frame.timestampUs - m_fpsChangeTimestampUs > kFpsChangeTimestampUsDifferenceThreshold)
    {
        m_fpsChangeTimestampUs = frame.timestampUs;
        NX_OUTPUT << "FPS: " << fps;
        m_fps = fps;
        m_objectDetectionProcessor->setFps(fps);
        Config newConfig(*m_config);
        newConfig.objectDetectionPeriod = calcObjectDetectionPeriod();
        m_config = std::make_shared<const Config>(newConfig);
        m_exponentialBackoffObjectDetectionPeriod = (float) m_config->objectDetectionPeriod;
    }
}

void DeviceAgent::processFrame(const IUncompressedVideoFrame* nxFrame) noexcept
{
    ++m_frameIndex;

    Frame frame(nxFrame, m_frameIndex);

    if (m_frameIndex == 0)
        m_fpsChangeTimestampUs = frame.timestampUs;

    if (m_config)
        updateConfigOnFpsChange(frame);

    ObjectDetectionProcessor::Result objectDetectionResult;
    try
    {
        objectDetectionResult = m_objectDetectionProcessor->run(
            frame, needToDetectObjects(nxFrame));
    }
    catch (const FrameProcessingError& e)
    {
        pushPluginDiagnosticEvent(
            IPluginDiagnosticEvent::Level::error,
            "Frame processing error.",
            e.what());
        m_terminated = true;
        return;
    }

    if (m_isExponentialBackoffActive)
    {
        if (objectDetectionResult.detections.empty())
        {
            if (m_frameIndex % (int) m_exponentialBackoffObjectDetectionPeriod == 0 &&
                m_exponentialBackoffObjectDetectionPeriod <
                m_maxExponentialBackoffObjectDetectionPeriod)
            {
                m_exponentialBackoffObjectDetectionPeriod *= 1.1;
                NX_OUTPUT << "Exponential backoff object detection period: " <<
                    m_exponentialBackoffObjectDetectionPeriod << ".";
            }
        }
        else
        {
            m_exponentialBackoffObjectDetectionPeriod = (float) m_config->objectDetectionPeriod;
            m_isExponentialBackoffActive = false;
        }
    }
    else
    {
        m_isExponentialBackoffActive = objectDetectionResult.detections.empty();
    }

    try
    {
        const MetadataPacketList metadataPacketList =
            convertObjectDetectionResultToMetadataPacketList(
                objectDetectionResult,
                frame.timestampUs);

        pushMetadataPackets(metadataPacketList);
    }
    catch (const std::exception& e)
    {
        pushPluginDiagnosticEvent(
            IPluginDiagnosticEvent::Level::error,
            "Metadata sending error.",
            e.what());
        m_terminated = true;
    }
}

RoiLineList DeviceAgent::parseLinesSettings()
{
    using namespace settings::roi_line;

    RoiLineList result;

    for (int i = 1; i < RoiLine::kMaxCount; ++i)
    {
        const std::string jsonString = settingValue(polyline::name(i));
        const auto roiLine = convertJsonStringToRoiLinePtr(jsonString);
        if (roiLine)
        {
            roiLine->index = i;
            result.push_back(roiLine);
        }
    }
    return result;
}

RoiAreaList DeviceAgent::parseAreasSettings()
{
    using namespace settings::roi_area;

    RoiAreaList result;

    for (int i = 1; i <= RoiArea::kMaxCount; ++i)
    {
        const std::string jsonString = settingValue(polygon::name(i));
        const auto roiArea = convertJsonStringToRoiAreaPtr(jsonString);
        if (roiArea)
        {
            roiArea->index = i;

            const std::string detectionsEnabled = settingValue(
                settingPrefix(i) + "DetectionsEnabled");

            roiArea->entranceDetectionEnabled =
                detectionsEnabled.find(entrance_detection_enabled::name(i)) != std::string::npos;

            roiArea->exitDetectionEnabled =
                detectionsEnabled.find(exit_detection_enabled::name(i)) != std::string::npos;

            roiArea->appearanceDetectionEnabled =
                detectionsEnabled.find(appearance_detection_enabled::name(i)) != std::string::npos;

            roiArea->disappearanceDetectionEnabled =
                detectionsEnabled.find(disappearance_detection_enabled::name(i)) !=
                std::string::npos;

            roiArea->loiteringDetectionEnabled =
                detectionsEnabled.find(loitering_detection_enabled::name(i)) != std::string::npos;

            roiArea->crossingEnabled =
                detectionsEnabled.find(crossing_enabled::name(i)) != std::string::npos;

            roiArea->detectionSensitivity = std::stof(settingValue(
                detection_sensitivity::name(i))) / 100.0F;

            roiArea->loiteringDetectionDuration = seconds(std::stoi(settingValue(
                loitering_detection_duration::name(i))));

            result.push_back(roiArea);
        }
    }
    return result;
}

int DeviceAgent::calcObjectDetectionPeriod() const
{
    const int detectionPeriod = std::max((int) (m_fps / (float) m_detectionFrequencyFps), 1);

    NX_OUTPUT << "Detection period: " << detectionPeriod;

    return detectionPeriod;
}

void DeviceAgent::parseSettings() noexcept
{
    if (m_terminated)
        return;
    try
    {
        const float minDetectionConfidence =
            std::stof(settingValue("minDetectionConfidence")) / 100.0F;

        const int threadCount = std::stoi(settingValue("threadCount"));

        m_detectionFrequencyFps = std::stoi(settingValue("detectionFrequencyFps"));

        const seconds minIntervalBetweenTracks =
            seconds(std::stoi(settingValue("minIntervalBetweenTracks")));

        const auto lines = parseLinesSettings();
        const auto areas = parseAreasSettings();

        m_config = std::make_shared<const Config>(Config({
            minDetectionConfidence,
            threadCount,
            calcObjectDetectionPeriod(),
            Config::Default::kMinReIdCosineSimilarity,
            minIntervalBetweenTracks,
            m_fps,
            lines,
            areas,
        }));
        m_exponentialBackoffObjectDetectionPeriod = (float) m_config->objectDetectionPeriod;

        if (!m_objectDetectionProcessor)
        {
            m_objectDetectionProcessor = std::make_unique<ObjectDetectionProcessor>(
                m_engine->pluginHomeDir(), logUtils, m_config);
        }
        else
        {
            m_objectDetectionProcessor->setConfig(m_config);
        }
    }
    catch (const CpuIsIncompatibleError& e)
    {
        pushPluginDiagnosticEvent(
            IPluginDiagnosticEvent::Level::error,
            "Error loading plugin.",
            "Error loading plugin: "s + e.what());
        m_terminated = true;
        m_config = nullptr;
    }
    catch (const std::exception& e)
    {
        pushPluginDiagnosticEvent(
            IPluginDiagnosticEvent::Level::error,
            "Error loading plugin.",
            "Error loading plugin: "s + e.what());
        m_terminated = true;
        m_config = nullptr;
    }
}

void DeviceAgent::doSetNeededMetadataTypes(
    Result<void>* /*outResult*/, const IMetadataTypes* /*neededMetadataTypes*/)
{
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
