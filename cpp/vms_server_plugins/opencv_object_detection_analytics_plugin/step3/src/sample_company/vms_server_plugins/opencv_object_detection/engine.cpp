// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "engine.h"

#include "device_agent.h"

namespace sample_company {
namespace vms_server_plugins {
namespace opencv_object_detection {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

Engine::Engine(std::filesystem::path pluginHomeDir):
    // Call the DeviceAgent helper class constructor telling it to verbosely report to stderr.
    nx::sdk::analytics::Engine(/*enableOutput*/ true),
    m_pluginHomeDir(pluginHomeDir)
{
}

Engine::~Engine()
{
}

/**
 * Called when the Server opens a video-connection to the camera if the plugin is enabled for this
 * camera.
 *
 * @param outResult The pointer to the structure which needs to be filled with the resulting value
 *     or the error information.
 * @param deviceInfo Contains various information about the related device such as its id, vendor,
 *     model, etc.
 */
void Engine::doObtainDeviceAgent(Result<IDeviceAgent*>* outResult, const IDeviceInfo* deviceInfo)
{
    *outResult = new DeviceAgent(deviceInfo, m_pluginHomeDir);
}

/**
 *  @return JSON with the particular structure. Note that it is possible to fill in the values
 * that are not known at compile time, but should not depend on the Engine settings.
 */
std::string Engine::manifestString() const
{
    // Ask the Server to supply uncompressed video frames in BGR format, as it is native format for
    // OpenCV.
    return /*suppress newline*/ 1 + R"json(
{
    "capabilities": "needUncompressedVideoFrames_bgr"
}
)json";
}

} // namespace opencv_object_detection
} // namespace vms_server_plugins
} // namespace sample_company
