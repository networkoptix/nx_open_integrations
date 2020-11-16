// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "utils.h"

#include <inference_engine.hpp>

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

bool toBool(std::string str)
{
    std::transform(str.begin(), str.begin(), str.end(), ::tolower);
    return str == "true" || str == "1";
}

int getTensorWidth(const InferenceEngine::TensorDesc& description)
{
    const auto& layout = description.getLayout();
    const auto& dims = description.getDims();
    const auto& size = dims.size();
    if (size >= 2 && (
        layout == InferenceEngine::Layout::NCHW ||
        layout == InferenceEngine::Layout::NHWC ||
        layout == InferenceEngine::Layout::NCDHW ||
        layout == InferenceEngine::Layout::NDHWC ||
        layout == InferenceEngine::Layout::OIHW ||
        layout == InferenceEngine::Layout::CHW ||
        layout == InferenceEngine::Layout::HW
        ))
    {
        // Regardless of the layout, dimensions are stored in the fixed order.
        return (int) dims.back();
    }
    else
    {
        THROW_IE_EXCEPTION << "Tensor does not have width dimension";
    }
}

int getTensorHeight(const InferenceEngine::TensorDesc& description)
{
    const auto& layout = description.getLayout();
    const auto& dims = description.getDims();
    const auto& size = dims.size();
    if (size >= 2 && (
        layout == InferenceEngine::Layout::NCHW ||
        layout == InferenceEngine::Layout::NHWC ||
        layout == InferenceEngine::Layout::NCDHW ||
        layout == InferenceEngine::Layout::NDHWC ||
        layout == InferenceEngine::Layout::OIHW ||
        layout == InferenceEngine::Layout::CHW ||
        layout == InferenceEngine::Layout::HW
        ))
    {
        // Regardless of the layout, dimensions are stored in the fixed order.
        return (int) dims.at(size - 2);
    }
    else
    {
        THROW_IE_EXCEPTION << "Tensor does not have height dimension";
    }
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
