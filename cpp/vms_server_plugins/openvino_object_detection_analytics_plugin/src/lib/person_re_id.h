// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <map>
#include <utility>
#include <vector>

#include <filesystem>
#include <boost/optional.hpp>

#include <opencv2/core/mat.hpp>

#include <inference_engine.hpp>

#include <nx/sdk/analytics/helpers/object_metadata.h>
#include <nx/sdk/analytics/rect.h>
#include <nx/sdk/helpers/log_utils.h>
#include <nx/sdk/uuid.h>

#include "config.h"
#include "geometry.h"
#include "network.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using PersonReIdVector = std::vector<float>;

class PersonReId: public Network
{
public:
    PersonReId(
        std::filesystem::path modelDir,
        nx::sdk::LogUtils logUtils,
        const std::shared_ptr<const Config> config);

    virtual std::string modelName() const override { return "person-reidentification-retail-0031"; }
    virtual std::string purpose() const override { return "person reidentification"; }

    cv::Mat run(const cv::Mat& person);

public:
    static constexpr int kChannelCount = 256;

protected:
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
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
