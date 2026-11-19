// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

// Loads a Server analytics plugin the way the Server does, feeds it video frames from a file, and
// prints the objects and events it produces. Used by test_linux.sh and test_windows.ps1.
//
// Usage: run_plugin <plugin library> <plugin home dir> <frames file> [<expected type id>...]
//
// The plugin home dir is where the plugin finds its files, e.g. the model files of the OpenCV
// plugin. The frames file is made by make_frames.py: a sequence of records, each an int32 width,
// int32 height and int32 repeat count, followed by width * height * 3 bytes of BGR pixels, which
// are sent to the plugin as `repeat count` frames. Exits with 1 if anything fails, or if the plugin
// produces no object or event of an expected type.

#include <cmath>
#include <cstdio>
#include <fstream>
#include <map>
#include <string>
#include <vector>

#if defined(_WIN32)
    #include <windows.h>
#else
    #include <dlfcn.h>
#endif

#include <nx/sdk/analytics/helpers/engine_info.h>
#include <nx/sdk/analytics/helpers/metadata_types.h>
#include <nx/sdk/analytics/i_consuming_device_agent.h>
#include <nx/sdk/analytics/i_engine.h>
#include <nx/sdk/analytics/i_event_metadata_packet.h>
#include <nx/sdk/analytics/i_integration.h>
#include <nx/sdk/analytics/i_object_metadata_packet.h>
#include <nx/sdk/analytics/i_uncompressed_video_frame.h>
#include <nx/sdk/helpers/device_info.h>
#include <nx/sdk/helpers/ref_countable.h>
#include <nx/sdk/helpers/string.h>
#include <nx/sdk/helpers/string_map.h>
#include <nx/sdk/i_utility_provider.h>

using namespace nx::sdk;
using namespace nx::sdk::analytics;

namespace {

class UtilityProvider: public RefCountable<IUtilityProvider>
{
public:
    explicit UtilityProvider(std::string homeDir): m_homeDir(std::move(homeDir)) {}

    virtual int64_t vmsSystemTimeSinceEpochMs() const override { return 0; }
    virtual const IString* getHomeDir() const override { return new String(m_homeDir); }
    virtual const IString* getServerSdkVersion() const override { return new String("6.1.3"); }
    virtual const char* serverId() const override
    {
        return "{00000000-0000-0000-0000-000000000001}";
    }
    virtual IString* cloudSystemId() const override { return new String(""); }
    virtual IString* cloudAuthKey() const override { return new String(""); }
    virtual void doSendHttpRequest(HttpDomainName, const char*, const char*, const char*,
        const char*, IHttpRequestCompletionHandler*) const override
    {
    }
    virtual const char* cloudToken() const override { return ""; }
    virtual void subscribeForCloudTokenUpdate(ICloudTokenSubscriber*) override {}
    virtual IString* supportedVectorizationModels() const override { return new String("[]"); }
    virtual IString* getDataDir() const override { return new String(m_homeDir); }

private:
    const std::string m_homeDir;
};

class Frame: public RefCountable<IUncompressedVideoFrame>
{
public:
    Frame(int width, int height, const char* data, int64_t timestampUs):
        m_width(width), m_height(height), m_data(data), m_timestampUs(timestampUs)
    {
    }

    virtual int64_t timestampUs() const override { return m_timestampUs; }
    virtual int width() const override { return m_width; }
    virtual int height() const override { return m_height; }
    virtual void getPixelAspectRatio(PixelAspectRatio* outValue) const override
    {
        *outValue = {1, 1};
    }
    virtual PixelFormat pixelFormat() const override { return PixelFormat::bgr; }
    virtual int planeCount() const override { return 1; }
    virtual int dataSize(int /*plane*/) const override { return m_width * m_height * 3; }
    virtual const char* data(int /*plane*/) const override { return m_data; }
    virtual int lineSize(int /*plane*/) const override { return m_width * 3; }
    virtual IList<IMetadataPacket>* getMetadataList() const override { return nullptr; }

private:
    const int m_width;
    const int m_height;
    const char* const m_data;
    const int64_t m_timestampUs;
};

class DeviceAgentHandler: public RefCountable<IDeviceAgent::IHandler>
{
public:
    std::map<std::string, int> counts;
    int diagnosticErrors = 0;

    virtual void handleMetadata(IMetadataPacket* packet) override
    {
        if (const auto objects = packet->queryInterface<IObjectMetadataPacket>())
        {
            for (int i = 0; i < objects->count(); ++i)
                ++counts[std::string("object ") + objects->at(i)->typeId()];
        }
        else if (const auto events = packet->queryInterface<IEventMetadataPacket>())
        {
            for (int i = 0; i < events->count(); ++i)
                ++counts[std::string("event ") + events->at(i)->typeId()];
        }
    }

    virtual void handleIntegrationDiagnosticEvent(IIntegrationDiagnosticEvent* event) override
    {
        printf("Diagnostic event: %s: %s\n", event->caption(), event->description());
        if (event->level() == IIntegrationDiagnosticEvent::Level::error)
            ++diagnosticErrors;
    }

    virtual void pushManifest(const IString* /*manifest*/) override {}
};

class EngineHandler: public RefCountable<IEngine::IHandler>
{
public:
    virtual void handleIntegrationDiagnosticEvent(IIntegrationDiagnosticEvent* event) override
    {
        printf("Engine diagnostic event: %s: %s\n", event->caption(), event->description());
    }

    virtual void pushManifest(const IString* /*manifest*/) override {}
};

using CreateNxPlugin = nx::sdk::IIntegration* (*)();

CreateNxPlugin loadPlugin(const char* path)
{
    #if defined(_WIN32)
        const HMODULE library = LoadLibraryA(path);
        if (!library)
        {
            fprintf(stderr, "FAIL: Cannot load %s: error %lu\n", path, GetLastError());
            return nullptr;
        }
        return (CreateNxPlugin) GetProcAddress(library, "createNxPlugin");
    #else
        void* const library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
        if (!library)
        {
            fprintf(stderr, "FAIL: Cannot load %s: %s\n", path, dlerror());
            return nullptr;
        }
        return (CreateNxPlugin) dlsym(library, "createNxPlugin");
    #endif
}

#define CHECK(condition, message) do \
{ \
    if (!(condition)) \
    { \
        fprintf(stderr, "FAIL: %s\n", message); \
        return 1; \
    } \
} while (0)

} // namespace

int main(int argc, char** argv)
{
    CHECK(argc >= 4, "Usage: run_plugin <plugin library> <plugin home dir> <frames file> "
        "[<expected type id>...]");

    const CreateNxPlugin createNxPlugin = loadPlugin(argv[1]);
    CHECK(createNxPlugin, "The library doesn't export createNxPlugin().");

    const Ptr<nx::sdk::IIntegration> integration(createNxPlugin());
    CHECK(integration, "createNxPlugin() returned null.");
    const auto analyticsIntegration =
        integration->queryInterface<nx::sdk::analytics::IIntegration>();
    CHECK(analyticsIntegration, "The plugin is not an analytics Integration.");
    const auto utilityProvider = makePtr<UtilityProvider>(argv[2]);
    analyticsIntegration->setUtilityProvider(utilityProvider.get());

    const auto engineResult = analyticsIntegration->createEngine();
    CHECK(engineResult.isOk(), "createEngine() failed.");
    const Ptr<IEngine> engine(engineResult.value());
    const auto engineHandler = makePtr<EngineHandler>();
    engine->setHandler(engineHandler.get());
    const auto engineInfo = makePtr<EngineInfo>();
    engineInfo->setId("{00000000-0000-0000-0000-000000000002}");
    engineInfo->setName("test");
    engine->setEngineInfo(engineInfo.get());
    const auto settings = makePtr<StringMap>();
    CHECK(engine->setSettings(settings.get()).isOk(), "Engine setSettings() failed.");

    const auto deviceInfo = makePtr<DeviceInfo>();
    deviceInfo->setId("{00000000-0000-0000-0000-000000000003}");
    deviceInfo->setName("camera");
    const auto deviceAgentResult = engine->obtainDeviceAgent(deviceInfo.get());
    CHECK(deviceAgentResult.isOk(), "obtainDeviceAgent() failed.");
    const Ptr<IDeviceAgent> deviceAgent(deviceAgentResult.value());
    const auto consumingDeviceAgent = deviceAgent->queryInterface<IConsumingDeviceAgent>();
    CHECK(consumingDeviceAgent, "The DeviceAgent doesn't consume video.");
    const auto handler = makePtr<DeviceAgentHandler>();
    deviceAgent->setHandler(handler.get());
    CHECK(deviceAgent->setSettings(settings.get()).isOk(), "DeviceAgent setSettings() failed.");

    // Ask for all object types the tutorial plugin produces (in the start code, the SDK sample's);
    // the Server asks for the types that the user's Analytics Rules or the Desktop Client need.
    const auto neededTypes = makePtr<MetadataTypes>();
    for (const char* typeId:
        {"nx.base.Person", "nx.base.Cat", "nx.base.Dog", "nx.sample.helloWorld"})
    {
        neededTypes->addObjectTypeId(typeId);
    }
    CHECK(deviceAgent->setNeededMetadataTypes(neededTypes.get()).isOk(),
        "setNeededMetadataTypes() failed.");

    std::ifstream framesFile(argv[3], std::ios::binary);
    CHECK(framesFile, "Cannot open the frames file.");
    int frameCount = 0;
    std::vector<char> pixels;
    for (;;)
    {
        int32_t header[3] = {}; //< width, height, repeat count
        if (!framesFile.read((char*) header, sizeof(header)))
            break;
        CHECK(header[0] > 0 && header[1] > 0 && header[2] > 0, "Bad frames file.");
        pixels.resize((size_t) header[0] * header[1] * 3);
        CHECK(framesFile.read(pixels.data(), pixels.size()), "Truncated frames file.");
        for (int i = 0; i < header[2]; ++i, ++frameCount)
        {
            const auto frame = makePtr<Frame>(
                header[0], header[1], pixels.data(), /*timestampUs*/ frameCount * 100'000LL);
            CHECK(consumingDeviceAgent->pushDataPacket(frame.get()).isOk(),
                "pushDataPacket() failed.");
        }
    }
    CHECK(frameCount > 0, "The frames file has no frames.");
    consumingDeviceAgent->finalize();

    printf("Frames: %d\n", frameCount);
    for (const auto& [type, count]: handler->counts)
        printf("%s: %d\n", type.c_str(), count);

    CHECK(handler->diagnosticErrors == 0, "The plugin reported errors.");
    for (int i = 4; i < argc; ++i)
    {
        if (handler->counts["object " + std::string(argv[i])] == 0
            && handler->counts["event " + std::string(argv[i])] == 0)
        {
            fprintf(stderr, "FAIL: No object or event of type %s.\n", argv[i]);
            return 1;
        }
    }
    return 0;
}
