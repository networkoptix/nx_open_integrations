// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "engine.h"

#include <thread>

#define NX_PRINT_PREFIX (this->logUtils.printPrefix)
#include <nx/kit/debug.h>
#include <nx/kit/json.h>
#include <nx/sdk/analytics/helpers/engine.h>
#include <nx/sdk/analytics/helpers/plugin.h>
#include <nx/sdk/analytics/i_device_agent.h>
#include <nx/sdk/i_device_info.h>
#include <nx/sdk/analytics/i_uncompressed_video_frame.h>
#include <nx/sdk/uuid.h>

#include "device_agent.h"
#include "lib/openvino_object_detection_analytics_plugin_ini.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

Engine::Engine(Plugin* plugin) noexcept:
    nx::sdk::analytics::Engine(NX_DEBUG_ENABLE_OUTPUT),
    m_plugin(plugin)
{
    obtainPluginHomeDir();
}

Engine::~Engine() noexcept
{
}

void Engine::doObtainDeviceAgent(Result<IDeviceAgent*>* outResult, const IDeviceInfo* deviceInfo)
{
    *outResult = new DeviceAgent(this, deviceInfo);
}

void Engine::obtainPluginHomeDir() noexcept
{
    const auto utilityProvider = m_plugin->utilityProvider();
    NX_KIT_ASSERT(utilityProvider);

    m_pluginHomeDir = std::filesystem::path(utilityProvider->homeDir());

    if (m_pluginHomeDir.empty())
        NX_PRINT << "Plugin home dir: absent";
    else
        NX_PRINT << "Plugin home dir: " << nx::kit::utils::toString(m_pluginHomeDir.string());
}

std::string Engine::manifestString() const noexcept
{
    constexpr int kSecondsPerDay = 86400;
    const int coreCount = (int) std::thread::hardware_concurrency();
    using nx::kit::Json;
    std::vector<Json> lineItems;
    for (int i = 1; i <= RoiLine::kMaxCount; ++i)
    {
        using namespace settings::roi_line;

        lineItems.push_back(Json::object {
            { "type", "LineFigure"},
            { "name", polyline::name(i) },
            { "caption", "Line #" + std::to_string(i) },
            { "maxPoints", RoiLine::kMaxPoints },
        });
    }
    Json linesGroupBox = Json::object {
        { "type", "GroupBox" },
        { "caption", "Lines" },
        { "items", Json(lineItems) }
    };

    std::vector<Json> areaMonitoringItems;
    for (int i = 1; i <= RoiArea::kMaxCount; ++i)
    {
        using namespace settings::roi_area;

        std::vector<Json> areaItems{};

        const std::string namePrefix = settingPrefix(i);

        areaItems.push_back(Json::object {
            { "type", "PolygonFigure" },
            { "name", polygon::name(i) },
            { "caption", "Area #" + std::to_string(i) },
            { "maxPoints", RoiArea::kMaxPoints },
        });

        areaItems.push_back(Json::object {
            { "type", "CheckBoxGroup" },
            { "name", namePrefix + "DetectionsEnabled" },
            { "caption", "Detections" },
            { "description", "Choose which events you want to capture with the plugin.<br>"
              "Define event response rules in Event Rules window." },
            { "defaultValue", Json::array {
                entrance_detection_enabled::name(i),
                exit_detection_enabled::name(i),
                appearance_detection_enabled::name(i),
                disappearance_detection_enabled::name(i),
                loitering_detection_enabled::name(i),
                crossing_enabled::name(i),
            }},
            { "range", Json::array {
                entrance_detection_enabled::name(i),
                exit_detection_enabled::name(i),
                appearance_detection_enabled::name(i),
                disappearance_detection_enabled::name(i),
                loitering_detection_enabled::name(i),
                crossing_enabled::name(i),
            }},
            { "itemCaptions", Json::object {
                { entrance_detection_enabled::name(i), "Entrance" },
                { exit_detection_enabled::name(i), "Exit" },
                { appearance_detection_enabled::name(i), "Appearance" },
                { disappearance_detection_enabled::name(i), "Disappearance" },
                { loitering_detection_enabled::name(i), "Loitering" },
                { crossing_enabled::name(i), "Crossing" },
            }},
        });

        areaItems.push_back(Json::object {
            { "type", "SpinBox" },
            { "name", detection_sensitivity::name(i) },
            { "caption", "Detection Sensitivity (%)" },
            { "description", "Sensitivity of object intersection with area." },
            { "defaultValue", (int) (detection_sensitivity::kDefault * 100) },
            { "minValue", 1 },
            { "maxValue", 100 },
        });
        areaItems.push_back(Json::object {
            { "type", "SpinBox" },
            { "name", loitering_detection_duration::name(i) },
            { "caption", "Loitering Duration (s)" },
            { "description", "Total time the object was in the area for triggering the event." },
            { "defaultValue", (int) loitering_detection_duration::kDefault.count() },
            { "minValue", 1 },
            { "maxValue", kSecondsPerDay },
        });

        areaMonitoringItems.push_back(Json::object {
            { "type", "GroupBox" },
            { "caption", "Area" },
            { "items", Json(areaItems) }
        });
    }
    using D = Config::Default;

    const auto performance = Json::object {
        { "type", "GroupBox" },
        { "caption", "Performance" },
        { "items", Json::array {
            Json::object {
                { "type", "SpinBox" },
                { "caption", "CPU Cores" },
                { "description", "Max number of logical CPU cores used for "
                  "object detection and tracking."},
                { "name", "threadCount" },
                { "defaultValue", coreCount },
                { "minValue", 1 },
                { "maxValue", coreCount },
            },
        } },
    };

    const auto objectDetection = Json::object {
        { "type", "GroupBox" },
        { "caption", "Object Detection" },
        { "items", Json::array {
            Json::object {
                { "type", "SpinBox" },
                { "caption", "Person Confidence (%)" },
                { "description",
                  "With this or greater percentage of confidence, the object "
                  "is identified as a person. "},
                { "name", "minDetectionConfidence" },
                { "defaultValue",
                  (int) round((double) D::kMinDetectionConfidence * 100) },
                { "minValue", 1 },
                { "maxValue", 100 },
            },
            Json::object {
                { "type", "SpinBox" },
                { "caption", "Detection Frequency (fps)" },
                { "description",
                  "Changing this value alters how often the detection runs."
                  "<br>A higher value will improve performance but can cause "
                  "inaccuracies." },
                { "name", "detectionFrequencyFps" },
                { "defaultValue", D::kDetectionFrequencyFps },
                { "minValue", 1 },
                { "maxValue", 100 },
            },
        } },
    };

    const auto objectTracking = Json::object {
        { "type", "GroupBox" },
        { "caption", "Object Tracking" },
        { "items", Json::array {
            Json::object {
                { "type", "SpinBox" },
                { "caption", "Track Reset Timeout (s)" },
                { "description",
                  "Tracks are considered different if detections of the same "
                  "person are separated by more than this value." },
                { "name", "minIntervalBetweenTracks" },
                { "defaultValue", (int) D::kMinIntervalBetweenTracks.count() },
                { "minValue", 1 },
                { "maxValue", kSecondsPerDay },
            },
        } },
    };

    const Json manifestJson = Json::object {
        { "capabilities", "needUncompressedVideoFrames_bgr" },
        { "streamTypeFilter", "motion|uncompressedVideo" },
        { "preferredStream", "secondary" },
        { "deviceAgentSettingsModel", Json::object {
            { "type", "Settings" },
            { "sections", Json::array {
                Json::object {
                    { "type", "Section" },
                    { "caption", "General" },
                    { "items", Json::array {
                        performance,
                        objectDetection,
                        objectTracking,
                    } },
                },
                Json::object {
                    { "type", "Section" },
                    { "caption", "Line Crossing" },
                    { "items", Json::array { linesGroupBox } },
                },
                Json::object {
                    { "type", "Section" },
                    { "caption", "Area Monitoring" },
                    { "items", Json(areaMonitoringItems) },
                },
            } },
        } },
    };
    return manifestJson.dump();
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection

namespace {

static const std::string kPluginManifest = R"json(
{
    "id": "nx.openvino_object_detection",
    "name": "OpenVINO Object Detection",
    "description": ")json"
        "This is an example open-source plugin demonstrating people detection and tracking. It "
        "may or may not fulfil the requirements of the particular video management system in "
        "terms of reliability and detection quality - use at your own risk. It is based on "
        "OpenVINO technology by Intel, and runs on Intel processors only."
        R"json(",
    "version": "1.0.0"
})json";

} // namespace

extern "C" NX_PLUGIN_API nx::sdk::IPlugin* createNxPlugin()
{
    return new nx::sdk::analytics::Plugin(
        kPluginManifest,
        [](nx::sdk::analytics::Plugin* plugin)
        {
            return new nx::vms_server_plugins::analytics::openvino_object_detection::Engine(plugin);
        });
}
