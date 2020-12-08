// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <filesystem>

#include <nx/sdk/analytics/helpers/engine.h>
#include <nx/sdk/analytics/helpers/plugin.h>
#include <nx/sdk/analytics/i_device_agent.h>
#include <nx/sdk/i_device_info.h>
#include <nx/sdk/analytics/i_uncompressed_video_frame.h>
#include <nx/sdk/uuid.h>

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

class Engine: public nx::sdk::analytics::Engine
{
public:
    Engine(nx::sdk::analytics::Plugin* plugin) noexcept;
    virtual ~Engine() noexcept override;

    std::filesystem::path pluginHomeDir() const noexcept { return m_pluginHomeDir; }

protected:
    virtual std::string manifestString() const noexcept override;
    virtual void doObtainDeviceAgent(
        nx::sdk::Result<nx::sdk::analytics::IDeviceAgent*>* outResult,
        const nx::sdk::IDeviceInfo* deviceInfo) override;

private:
    void obtainPluginHomeDir() noexcept;

private:
    std::filesystem::path m_pluginHomeDir; /**< Can be empty. */
    nx::sdk::analytics::Plugin* const m_plugin;
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
