// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include <iostream>
#include <exception>

#include <filesystem>

#include "app.h"

int main(int argc, char** argv)
{
    if (argc != 3)
    {
        std::cout << "Usage:\n"
            << argv[0] << " <input_video_file> <model_dir>\n";
        return 1;
    }
    try
    {
        auto inputFile = std::filesystem::path(argv[1]);
        auto modelDir = std::filesystem::path(argv[2]);
        nx::vms_server_plugins::analytics::openvino_object_detection::App app(inputFile, modelDir);
        app.run();
    }
    catch (const std::exception& e)
    {
        std::cerr << "Failure: " << e.what();
        return 1;
    }
    catch (...)
    {
        std::cerr << "Failure: unknown exception.";
        return 1;
    }
    return 0;
}
