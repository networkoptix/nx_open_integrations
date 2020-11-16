// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <filesystem>
#include <boost/optional.hpp>

#include <inference_engine.hpp>

#include <nx/sdk/helpers/log_utils.h>

#include "config.h"
#include "openvino_log_utils.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

class Network
{
public:
    Network(
        std::filesystem::path modelDir,
        nx::sdk::LogUtils logUtils,
        const std::shared_ptr<const Config>&);
    virtual ~Network() { m_network.reset(nullptr); }

    virtual void setConfig(const std::shared_ptr<const Config>& config);

public:
    virtual std::string modelName() const = 0;
    virtual std::string purpose() const = 0;

protected:
    /**
     * Should be called from derived class constructors because of the usage of virtual methods.
     */
    void init(const std::shared_ptr<const Config>& config);

    virtual InferenceEngine::CNNNetwork loadModel();
    virtual void prepareInputBlobs(InferenceEngine::CNNNetwork network);
    virtual void prepareOutputBlobs(InferenceEngine::CNNNetwork network);
    std::filesystem::path modelBasePath() const;
    bool checkLayerParameter(
        const std::string& parameterDescription,
        int actualValue,
        int expectedValue) const;

    virtual int expectedInputSize() const = 0;

    virtual boost::optional<InferenceEngine::Precision> inputPrecision() const
    {
        return {}; //< No need to adjust the precision.
    }

    virtual boost::optional<InferenceEngine::Layout> inputLayout() const
    {
        return {}; //< No need to adjust the precision.
    }

    virtual int expectedOutputSize() const = 0;

    virtual boost::optional<InferenceEngine::Precision> outputPrecision() const
    {
        return {}; //< No need to adjust the precision.
    }

    virtual boost::optional<InferenceEngine::Layout> outputLayout() const
    {
        return {}; //< No need to adjust the precision.
    }

    virtual void createInferenceRequest();

protected:
    nx::sdk::LogUtils logUtils;
    std::filesystem::path m_modelDir;
    std::string m_inputName;
    std::string m_outputName;
    InferenceEngine::InputInfo::Ptr m_input;
    InferenceEngine::DataPtr m_output;
    InferenceEngine::ExecutableNetwork m_network;
    InferenceEngine::InferRequest m_inferenceRequest;
    std::shared_ptr<const Config> m_config;

private:
    void prepareNetwork();
    void loadNetworkIntoInferenceEngine();

private:
    InferenceEngine::Core m_inferenceEngine;
    InferenceEngine::CNNNetwork m_cnnNetwork;
};

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
