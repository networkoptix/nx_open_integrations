// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <string>
#include <vector>

#include <inference_engine.hpp>

#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

bool toBool(std::string str);

int getTensorWidth(const InferenceEngine::TensorDesc& description);
int getTensorHeight(const InferenceEngine::TensorDesc& description);

/**
 * Sets the image data stored in cv::Mat object to a given Blob object.
 *
 * @param image - given cv::Mat object with an image data.
 * @param blob - Blob object which to be filled by an image data.
 * @param batchIndex - batch index of an image inside of the blob.
 */
template<typename Item>
void matU8ToBlob(const cv::Mat& image, const InferenceEngine::Blob::Ptr& blob, int batchIndex = 0)
{
    InferenceEngine::SizeVector blobSize = blob->getTensorDesc().getDims();
    static constexpr int kWidthIndex = 3;
    static constexpr int kHeightIndex = 2;
    static constexpr int kChannelIndex = 1;
    const int width = (int) blobSize[kWidthIndex];
    const int height = (int) blobSize[kHeightIndex];
    const int channels = (int) blobSize[kChannelIndex];
    Item* const blobData = blob->buffer().as<Item*>();

    cv::Mat resizedImage(image);
    if (width != image.size().width || height != image.size().height)
        cv::resize(image, resizedImage, cv::Size(width, height));

    const int batchOffset = batchIndex * width * height * channels;

    for (int c = 0; c < channels; ++c)
    {
        for (int h = 0; h < height; ++h)
        {
            for (int w = 0; w < width; ++w)
            {
                blobData[batchOffset + c * width * height + h * width + w] =
                    resizedImage.at<cv::Vec3b>(h, w)[c];
            }
        }
    }
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
