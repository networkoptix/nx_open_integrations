// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <boost/optional.hpp>

#include <opencv2/core/mat.hpp>

#include <inference_engine.hpp>

#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/helpers/log_utils.h>

#include "config.h"
#include "openvino_log_utils.h"
#include "network.h"
#include "detection.h"
#include "frame.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

class ObjectDetector: public Network
{
public:
    ObjectDetector(
        std::filesystem::path modelDir,
        nx::sdk::LogUtils logUtils,
        const std::shared_ptr<const Config>& config);

    virtual std::string modelName() const override
        { return "pedestrian-and-vehicle-detector-adas-0001"; }

    virtual std::string purpose() const override { return "object detection"; }

    DetectionList run(const Frame& frame);

protected:
    virtual InferenceEngine::CNNNetwork loadModel() override;
    virtual void prepareInputBlobs(InferenceEngine::CNNNetwork network) override;
    virtual void prepareOutputBlobs(InferenceEngine::CNNNetwork network) override;

    virtual int expectedInputSize() const override { return 1; }

    virtual boost::optional<InferenceEngine::Precision> inputPrecision() const override
    {
        return InferenceEngine::Precision(InferenceEngine::Precision::U8);
    }

    virtual boost::optional<InferenceEngine::Layout> inputLayout() const override
    {
        return InferenceEngine::Layout::NCHW;
    }

    virtual int expectedOutputSize() const override { return 1; }

    virtual boost::optional<InferenceEngine::Precision> outputPrecision() const override
    {
        return InferenceEngine::Precision(InferenceEngine::Precision::FP32);
    }

    virtual boost::optional<InferenceEngine::Layout> outputLayout() const override
    {
        return InferenceEngine::Layout(InferenceEngine::Layout::NCHW);
    }

    virtual void createInferenceRequest() override;

private:
    DetectionList runImpl(const Frame& frame);

    std::shared_ptr<Detection> convertRawDetectionToDetection(
        const float rawDetection[],
        int64_t timestampUs) const;

    void setImageInfoBlob();

private:
    std::vector<std::string> m_labels;
    int m_maxProposalCount = 0;
    int m_objectSize = 0;
    int m_networkInputHeight = 0;
    int m_networkInputWidth = 0;
};

const std::string kPersonObjectType = "nx.openvino_object_detection.person";
const std::string kPersonObjectName = "Person";

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
