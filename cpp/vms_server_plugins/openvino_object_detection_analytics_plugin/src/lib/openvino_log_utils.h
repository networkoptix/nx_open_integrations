// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <inference_engine.hpp>

#include <nx/sdk/helpers/log_utils.h>

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

class OpenVinoLogUtils
{
public:
    OpenVinoLogUtils(nx::sdk::LogUtils logUtils = nx::sdk::LogUtils(true, ""));
    void printInferenceEnginePluginVersion(const InferenceEngine::Version& version) const;

protected:
    nx::sdk::LogUtils logUtils;
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
