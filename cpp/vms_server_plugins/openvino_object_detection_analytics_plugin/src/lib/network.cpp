// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "network.h"

#include <chrono>
#include <fstream>
#include <vector>

//#include <ext_list.hpp>
#include <inference_engine.hpp>
//#include <ie_extension.h>

#define NX_PRINT_PREFIX (this->logUtils.printPrefix)
#include <nx/kit/debug.h>
#include <nx/kit/utils.h>
#include <nx/sdk/helpers/log_utils.h>

#include "config.h"
#include "exceptions.h"
#include "openvino_object_detection_analytics_plugin_ini.h"
#include "openvino_log_utils.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace std::string_literals;

using namespace nx::sdk;

Network::Network(
    std::filesystem::path modelDir,
    LogUtils logUtils,
    const std::shared_ptr<const Config>& /*config*/)
    :
    logUtils(logUtils),
    m_modelDir(std::move(modelDir))
{
}

void Network::init(const std::shared_ptr<const Config>& config)
{
    setConfig(config);
}

//std::string Network::getCpuExtensionsLibraryName()
//{
//    using namespace std::string_literals;
//
//    std::string name;
//    std::string baseName;
//    std::vector<cpu_feature_t> features = cpuFeatures();
//    for (const cpu_feature_t& cpuFeature: features)
//    {
//        if (cpuFeature == CPU_FEATURE_SSE4_2)
//            baseName = "cpu_extension_sse4";
//        else if (cpuFeature == CPU_FEATURE_AVX2)
//            baseName = "cpu_extension_avx2";
//        else if (cpuFeature == CPU_FEATURE_AVX512F)
//            baseName = "cpu_extension_avx512";
//        #if defined(WIN32)
//            name = baseName + ".dll"s;
//        #else
//            name = "lib"s + baseName + ".so"s;
//        #endif
//        const std::filesystem::path path = m_modelDir / name;
//        if (std::filesystem::exists(path))
//            return path.string();
//    }
//    throw CpuIsIncompatibleError("CPU is not supported.");
//}

void Network::setConfig(const std::shared_ptr<const Config>& config)
{
//    using namespace InferenceEngine;
//    #if defined(WIN32)
//        SetDllDirectoryW(m_modelDir.wstring().c_str());
//    #endif
//    auto extensionPtr = make_so_pointer<IExtension>(getCpuExtensionsLibraryName());
//    m_inferenceEngine.AddExtension(std::static_pointer_cast<IExtension>(extensionPtr), "CPU");
//    #if defined(WIN32)
//        SetDllDirectoryW(nullptr);
//    #endif

    m_config = config;
    prepareNetwork();
    loadNetworkIntoInferenceEngine();
    createInferenceRequest();
}

//-------------------------------------------------------------------------------------------------
// private

/**
 * Loads person and vehicle detection model.
 *
 * Ability to select other models will be added in future versions of OpenVINO object detection
 * plugin.
 *
 */
InferenceEngine::CNNNetwork Network::loadModel()
{
    const auto modelXml = m_modelDir / modelBasePath().replace_extension("xml");
    NX_OUTPUT << "    Read network from: " << modelXml;

    const auto modelBin = m_modelDir / modelBasePath().replace_extension("bin");
    NX_OUTPUT << "    Read weights from: " << modelBin;

    InferenceEngine::Core ie;
    InferenceEngine::CNNNetwork result = ie.ReadNetwork(modelXml.string(), modelBin.string());

    NX_OUTPUT << "    Batch size is forced to 1.";
    result.setBatchSize(1);

    return result;
}

bool Network::checkLayerParameter(
    const std::string& parameterDescription,
    int actualValue,
    int expectedValue) const
{
    if (actualValue != expectedValue)
    {
        NX_OUTPUT << "This plugin accepts " << purpose() << " networks that have "
            << std::to_string(expectedValue) << " " << parameterDescription
            << "(actual value: " << std::to_string(actualValue) << ").";
        return false;
    }
    return true;
}

void Network::createInferenceRequest()
{
    m_inferenceRequest = m_network.CreateInferRequest();
}

void Network::prepareInputBlobs(InferenceEngine::CNNNetwork network)
{
    NX_OUTPUT << "    Prepare input blobs.";
    InferenceEngine::InputsDataMap inputInfo(network.getInputsInfo());
    const auto inputSize = (int) inputInfo.size();
    if (!checkLayerParameter("input(s)", inputSize, expectedInputSize()))
        throw ModelLoadingError("Failed to prepare input of network.");
    m_inputName = inputInfo.begin()->first;
    m_input = inputInfo.begin()->second;
    if (inputPrecision())
        m_input->setPrecision(*inputPrecision());
    if (inputLayout())
        m_input->setLayout(*inputLayout());
}

void Network::prepareOutputBlobs(InferenceEngine::CNNNetwork network)
{
    NX_OUTPUT << "    Prepare output blobs.";
    InferenceEngine::OutputsDataMap outputInfo(network.getOutputsInfo());
    const auto outputSize = (int) outputInfo.size();
    if (!checkLayerParameter("output(s)", outputSize, expectedOutputSize()))
        throw ModelLoadingError("Failed to prepare output of network.");
    m_outputName = outputInfo.begin()->first;
    m_output = outputInfo.begin()->second;
    if (outputPrecision())
        m_output->setPrecision(*outputPrecision());
    if (outputLayout())
        m_output->setLayout(*outputLayout());
}

void Network::prepareNetwork()
{
    NX_OUTPUT << "Loading " << purpose() << " model.";
    m_cnnNetwork = loadModel();
    prepareInputBlobs(m_cnnNetwork);
    prepareOutputBlobs(m_cnnNetwork);
}

void Network::loadNetworkIntoInferenceEngine()
{
    std::map<std::string, std::string> networkConfig;
    const auto kKeyCpuThreadCount = InferenceEngine::PluginConfigParams::KEY_CPU_THREADS_NUM;
    networkConfig[kKeyCpuThreadCount] = std::to_string(m_config->threadCount);
    m_network = m_inferenceEngine.LoadNetwork(m_cnnNetwork, "CPU", networkConfig);
}

std::filesystem::path Network::modelBasePath() const
{
    return std::filesystem::path(modelName());
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
