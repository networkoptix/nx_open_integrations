// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "openvino_log_utils.h"

#include <inference_engine.hpp>

#define NX_PRINT_PREFIX (this->logUtils.printPrefix)
#define NX_DEBUG_ENABLE_OUTPUT (this->logUtils.enableOutput)
#include <nx/kit/debug.h>
#include <nx/sdk/helpers/log_utils.h>

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

OpenVinoLogUtils::OpenVinoLogUtils(sdk::LogUtils logUtils):
    logUtils(logUtils)
{
}

void OpenVinoLogUtils::printInferenceEnginePluginVersion(
    const InferenceEngine::Version& version) const
{
    NX_OUTPUT << "    Plugin version: "
        << version.apiVersion.major << "." << version.apiVersion.minor;
    NX_OUTPUT << "    Plugin name: " << (version.description ? version.description : "UNKNOWN");
    NX_OUTPUT << "    Plugin build: " << (version.buildNumber ? version.buildNumber : "UNKNOWN");
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
