// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "object_detector.h"

#include <opencv2/core/mat.hpp>

#include <inference_engine.hpp>

#define NX_PRINT_PREFIX (this->logUtils.printPrefix)
#include <nx/kit/debug.h>
#include <nx/kit/utils.h>
#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/helpers/log_utils.h>

#include <chrono>
#include <fstream>
#include <vector>

#include "config.h"
#include "exceptions.h"
#include "openvino_object_detection_analytics_plugin_ini.h"
#include "utils.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace nx::sdk;
using namespace nx::sdk::analytics;

ObjectDetector::ObjectDetector(
    std::filesystem::path modelDir,
    LogUtils logUtils,
    const std::shared_ptr<const Config>& config)
    :
    Network(std::move(modelDir), std::move(logUtils), config)
{
    init(config);
}

DetectionList ObjectDetector::run(const Frame& frame)
{
    try
    {
        return runImpl(frame);
    }
    catch (const std::exception& e)
    {
        throw ObjectDetectionError(e.what());
    }
}

//-------------------------------------------------------------------------------------------------
// private

DetectionList ObjectDetector::runImpl(const Frame& frame)
{
    if (!m_config)
        throw InferenceError("Config is not set.");

    using namespace std::chrono;
    using namespace InferenceEngine;

    const auto startTime = high_resolution_clock::now();

    Blob::Ptr frameBlob = m_inferenceRequest.GetBlob(m_inputName);
    matU8ToBlob<uint8_t>(frame.cvMat, frameBlob);

    m_inferenceRequest.StartAsync();

    DetectionList result;
    if (m_inferenceRequest.Wait(IInferRequest::WaitMode::RESULT_READY) == OK)
    {
        using FloatPrecision = PrecisionTrait<Precision::FP32>::value_type*;
        Blob::Ptr outputBlob = m_inferenceRequest.GetBlob(m_outputName);
        const float* const detections = outputBlob->buffer().as<FloatPrecision>();
        for (int i = 0; i < m_maxProposalCount; ++i)
        {
            const float* const detectionPtr = detections + i * m_objectSize;
            const auto detection = convertRawDetectionToDetection(
                /*rawDetection*/ detectionPtr,
                /*timestampUs*/ frame.timestampUs);
            if (detection)
                result.push_back(detection);
        }
    }

    const auto finishTime = high_resolution_clock::now();
    const auto duration = duration_cast<milliseconds>(finishTime - startTime);
    NX_OUTPUT << "Detection duration: " << duration.count() << " ms.";

    return result;
}

/**
 * Loads person and vehicle detection model.
 *
 * Ability to select other models will be added in future versions of OpenVINO object detection
 * plugin.
 *
 */
InferenceEngine::CNNNetwork ObjectDetector::loadModel()
{
    const auto modelLabels = m_modelDir / modelBasePath().replace_extension("labels");
    NX_OUTPUT << "    Read labels from: " << modelLabels;
    std::ifstream inputFile(modelLabels.string());
    m_labels.clear();
    std::copy(
        std::istream_iterator<std::string>(inputFile),
        std::istream_iterator<std::string>(),
        std::back_inserter(m_labels));
    if (m_labels.empty())
        NX_OUTPUT << "    No labels were read, please check that file: '"
            << modelLabels.string() << "' is present, readable and contains labels.";

    return Network::loadModel();
}

void ObjectDetector::prepareInputBlobs(InferenceEngine::CNNNetwork network)
{
    Network::prepareInputBlobs(network);
    InferenceEngine::InputsDataMap inputInfo(network.getInputsInfo());
    auto inputInfoItem = inputInfo.begin();
    const InferenceEngine::TensorDesc& inputDescription = inputInfoItem->second->getTensorDesc();
    m_networkInputHeight = getTensorHeight(inputDescription);
    m_networkInputWidth = getTensorWidth(inputDescription);
}

void ObjectDetector::prepareOutputBlobs(InferenceEngine::CNNNetwork network)
{
    Network::prepareOutputBlobs(network);
    InferenceEngine::CNNLayerPtr layer = network.getLayerByName(m_outputName.c_str());
    const int classesCount = layer->GetParamAsInt("num_classes");
    const int labelsSize = (int) m_labels.size();
    if (labelsSize != classesCount)
    {
        if (labelsSize == classesCount - 1)
        {
            m_labels.insert(m_labels.begin(), "Background");
            NX_OUTPUT << "Added missing background label.";
        }
        else
        {
            m_labels.clear();
            NX_OUTPUT << "Label count does not match to number of classes of network.";
        }
    }
    const auto outputDims = m_output->getTensorDesc().getDims();
    constexpr int kExpectedOutputDimsSize = 4;
    const auto outputDimsSize = (int) outputDims.size();
    std::string description = "as output dimension size";
    if (!checkLayerParameter(description, outputDimsSize, kExpectedOutputDimsSize))
        throw ModelLoadingError("Failed to prepare output of network.");
    constexpr int kMaxProposalCountIndex = 2;
    m_maxProposalCount = (int) outputDims[kMaxProposalCountIndex];
    constexpr int kObjectSizeIndex = 3;
    m_objectSize = (int) outputDims[kObjectSizeIndex];
    constexpr int kExpectedObjectSize = 7;
    description = "as the last dimension of output";
    if (!checkLayerParameter(description,  m_objectSize, kExpectedObjectSize))
        throw ModelLoadingError("Failed to prepare output of network.");
}

void ObjectDetector::setImageInfoBlob()
{
    using namespace InferenceEngine;
    auto blob = m_inferenceRequest.GetBlob(m_inputName);
    auto data = blob->buffer().as<PrecisionTrait<Precision::FP32>::value_type*>();
    data[0] = static_cast<float>(m_networkInputHeight);  //< height
    data[1] = static_cast<float>(m_networkInputWidth);  //< width
    data[2] = 1;
}

void ObjectDetector::createInferenceRequest()
{
    Network::createInferenceRequest();
    setImageInfoBlob();
}

std::shared_ptr<Detection> ObjectDetector::convertRawDetectionToDetection(
    const float rawDetection[],
    int64_t timestampUs) const
{
    const float imageId = rawDetection[0];
    // Proposal count for the current frame is smaller than m_maxProposalCount.
    if (imageId < 0)
        return {};

    const auto labelIndex = (std::vector<std::string>::size_type) rawDetection[1];
    const std::string label = m_labels.empty() ?
        nx::kit::utils::format("#%d", labelIndex) : m_labels[labelIndex];
    const float confidence = rawDetection[2];

    // In current version of OpenVINO object detection plugin only persons are detected.
    const bool isPerson = label == "person";
    const bool isConfident = confidence > m_config->minDetectionConfidence;
    if (!isPerson || !isConfident)
        return {};

    const float xMin = rawDetection[3];
    const float yMin = rawDetection[4];
    const float xMax = rawDetection[5];
    const float yMax = rawDetection[6];

    NX_OUTPUT << "Detection:";
    NX_OUTPUT << "    Label: " << label;
    NX_OUTPUT << "    Confidence: " << confidence;
    NX_OUTPUT << "    Coordinates: (" << xMin << "; " << yMin << "); "
        << "(" << xMax << "; " << yMax << ")";

    const auto result = std::make_shared<Detection>(Detection{
        /*boundingBox*/ {{xMin, yMin}, {xMax, yMax}},
        /*confidence*/ confidence,
        /*trackId*/ Uuid(),
        /*timestampUs*/ timestampUs,
    });
    return result;
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
