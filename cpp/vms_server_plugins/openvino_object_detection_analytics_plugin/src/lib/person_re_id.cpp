// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "person_re_id.h"

#include <chrono>
#include <fstream>
#include <utility>
#include <vector>

#include <opencv2/core/mat.hpp>

#include <inference_engine.hpp>

#define NX_PRINT_PREFIX (this->logUtils.printPrefix)
#include <nx/kit/debug.h>
#include <nx/kit/utils.h>
#include <nx/sdk/helpers/uuid_helper.h>
#include <nx/sdk/uuid.h>
#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/helpers/log_utils.h>

#include "config.h"
#include "exceptions.h"
#include "openvino_object_detection_analytics_plugin_ini.h"
#include "network.h"
#include "utils.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace std::chrono;

using namespace nx::sdk;
using namespace nx::sdk::analytics;

PersonReId::PersonReId(
    std::filesystem::path modelDir,
    LogUtils logUtils,
    const std::shared_ptr<const Config> config):
    Network(modelDir, logUtils, config)
{
    init(config);
}

cv::Mat PersonReId::run(const cv::Mat& person)
{
    using namespace std::chrono;
    using namespace InferenceEngine;

    const auto startTime = high_resolution_clock::now();

    InferRequest inferenceRequest = m_network.CreateInferRequest();
    auto frameBlob = inferenceRequest.GetBlob(m_inputName);
    matU8ToBlob<uint8_t>(person, frameBlob);

    inferenceRequest.StartAsync();

    cv::Mat result;
    if (inferenceRequest.Wait(IInferRequest::WaitMode::RESULT_READY) == OK)
    {
        const InferenceEngine::Blob::Ptr attributesBlob = inferenceRequest.GetBlob(m_outputName);
        const auto outputValues = attributesBlob->buffer().as<float*>();
        cv::Mat1f(1, kChannelCount, outputValues).copyTo(result);
    }
    else
    {
        throw InferenceError("Person re-identification failed.");
    }
    const auto finishTime = high_resolution_clock::now();
    const auto duration = duration_cast<milliseconds>(finishTime - startTime);
    NX_OUTPUT << "Person re-identification duration: " << duration.count() << " ms.";

    return result;
}

//-------------------------------------------------------------------------------------------------
// private

void PersonReId::prepareOutputBlobs(InferenceEngine::CNNNetwork network)
{
    Network::prepareOutputBlobs(network);
    const auto outputDims = m_output->getTensorDesc().getDims();
    static const std::string kDescription = "as output dimension size";
    const auto outputDimsSize = (int) outputDims.size();
    static constexpr int kExpectedOutputDimsSize = 2;
    if (!checkLayerParameter(kDescription, outputDimsSize, kExpectedOutputDimsSize))
        throw ModelLoadingError("Failed to prepare output of network.");
    const auto channelCount = (int) outputDims.at(1);
    if (!checkLayerParameter("as channel count", channelCount, kChannelCount))
        throw ModelLoadingError("Failed to prepare output of network.");
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
