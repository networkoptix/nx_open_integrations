// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "person_tracker.h"

#include <boost/optional.hpp>

#include <opencv2/core/core.hpp>

#include "exceptions.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

using namespace std::string_literals;

using namespace cv;
using namespace cv::tbm;

using namespace nx::sdk;
using namespace nx::sdk::analytics;

PersonTracker::PersonTracker(
    std::filesystem::path modelDir,
    LogUtils logUtils,
    const std::shared_ptr<const Config>& config)
    :
    logUtils(std::move(logUtils)),
    m_modelDir(std::move(modelDir))
{
    setConfig(config);
}

void PersonTracker::setConfig(const std::shared_ptr<const Config> config, bool updateFpsOnly)
{
    if (!updateFpsOnly)
    {
        m_personReIdDescriptor = std::make_shared<PersonReIdDescriptor>(PersonReIdDescriptor(
                m_modelDir, logUtils, config));
    }
    m_tracker = createPersonTrackerByMatching(config->minFrameCountIntervalBetweenTracks());
}

PersonTracker::Result PersonTracker::run(const Frame& frame, const DetectionList& detections)
{
    try
    {
        return runImpl(frame, detections);
    }
    catch (const cv::Exception& e)
    {
        throw ObjectTrackingError(cvExceptionToStdString(e));
    }
    catch (const std::exception& e)
    {
        throw ObjectTrackingError(e.what());
    }
}

//-------------------------------------------------------------------------------------------------
// private

PersonTracker::Result PersonTracker::runImpl(const Frame& frame, const DetectionList& detections)
{
    TrackedObjects detectionsToTrack = convertDetectionsToTrackedObjects(frame, detections);

    // Perform tracking and extract tracked detections.
    m_tracker->process(frame.cvMat, detectionsToTrack, (uint64_t) frame.timestampUs);
    const TrackedObjects trackedDetections = m_tracker->trackedDetections();

    DetectionInternalList detectionsInternal =
        convertTrackedObjectsToDetections(frame, trackedDetections, m_idMapper.get());

    processDetections(frame, detectionsInternal);

    finishTracks();

    EventList events = generateEvents();
    BestShotList bestShots = extractBestShots();

    cleanup();

    DetectionList resultingDetections = extractDetectionList(detectionsInternal);

    return {
        std::move(bestShots),
        std::move(resultingDetections),
        std::move(events),
        std::move(extractTracks()),
    };
}

BestShotList PersonTracker::extractBestShots() const
{
    BestShotList result;
    for (const auto& pair: m_tracks)
    {
        const TrackPtr& track = pair.second;
        if (track->bestShot())
            result.push_back(track->bestShot());
    }
    return result;
}

TrackList PersonTracker::extractTracks() const
{
    TrackList result;
    result.reserve(m_tracks.size());
    for (const auto& pair: m_tracks)
        result.push_back(pair.second);
    return result;
}

void PersonTracker::finishTracks()
{
    const std::unordered_map<size_t, cv::tbm::Track> cvTracks = m_tracker->tracks();
    for (const auto& pair: cvTracks)
    {
        const size_t cvTrackId = pair.first;
        const cv::tbm::Track& cvTrack = pair.second;

        const Uuid trackId = m_idMapper->get(cvTrack.first_object.object_id);

        if (m_tracker->isTrackForgotten(cvTrackId))
        {
            if (m_tracks.find(trackId) != m_tracks.end())
                m_tracks[trackId]->finish();
        }
    }
}

cv::Ptr<ITrackerByMatching> PersonTracker::createPersonTrackerByMatching(int forgetDelay)
{
    TrackerParams params;

    params.aff_thr_fast = 0.9F;
    params.aff_thr_strong = 0.5F;
    params.drop_forgotten_tracks = false; //< To detect just finished tracks
    params.forget_delay = forgetDelay;
    params.max_num_objects_in_track = 0; //< Unlimited

    cv::Ptr<ITrackerByMatching> tracker = createTrackerByMatching(params);

    static const Size kDescriptorFastSize(16, 32);
    std::shared_ptr<IImageDescriptor> descriptorFast =
        std::make_shared<ResizedImageDescriptor>(
            kDescriptorFastSize, InterpolationFlags::INTER_LINEAR);
    std::shared_ptr<IDescriptorDistance> distanceFast =
        std::make_shared<MatchTemplateDistance>();

    tracker->setDescriptorFast(descriptorFast);
    tracker->setDistanceFast(distanceFast);

    std::shared_ptr<IDescriptorDistance> distanceStrong =
        std::make_shared<CosDistance>(CosDistance(cv::Size(
            /*_width*/ PersonReId::kChannelCount,
            /*_height*/ 1)));

    tracker->setDescriptorStrong(m_personReIdDescriptor);
    tracker->setDistanceStrong(distanceStrong);

    return tracker;
}

/**
 * Cleanup ids of the objects that belong to the forgotten tracks.
 */
void PersonTracker::cleanupIds()
{
    std::set<Uuid> validIds;
    for (const auto& pair: m_tracks)
        validIds.insert(pair.first);
    m_idMapper->removeAllExcept(validIds);
}

void PersonTracker::cleanupTracks()
{
    for (const auto& pair: m_tracker->tracks())
    {
        const auto cvTrackId = (int64_t) pair.first;
        if (m_tracker->isTrackForgotten((size_t) cvTrackId))
        {
            const cv::tbm::Track& cvTrack = pair.second;
            const Uuid trackId = m_idMapper->get(cvTrack.first_object.object_id);
            m_tracks.erase(trackId);
        }
    }
}

void PersonTracker::cleanup()
{
    cleanupTracks();
    m_tracker->dropForgottenTracks();
    cleanupIds();
}

std::shared_ptr<Track> PersonTracker::getOrCreateTrack(const Uuid& trackId)
{
    std::shared_ptr<Track> result;
    if (m_tracks.find(trackId) == m_tracks.end())
    {
        result = std::make_shared<Track>(
            /*id*/ trackId,
            /*maxDetectionCount*/ m_tracker->params().max_num_objects_in_track);
        m_tracks.insert(std::make_pair(trackId, result));
    }
    else
    {
        result = m_tracks[trackId];
    }
    return result;
}

void PersonTracker::copyDetectionsHistoryToTrack(
    const Frame& frame,
    int64_t cvTrackId,
    Track* track) const
{
    const cv::tbm::Track& cvTrack = m_tracker->tracks().at((size_t) cvTrackId);
    for (const TrackedObject& trackedDetection: cvTrack.objects)
    {
        if ((int64_t) trackedDetection.timestamp == frame.timestampUs)
            continue;

        std::shared_ptr<const DetectionInternal> detection = convertTrackedObjectToDetection(
            frame,
            trackedDetection,
            m_idMapper.get());
        track->addDetection(
            (int64_t) trackedDetection.timestamp,
            detection->detection,
            /*isTrackStarted*/ false);
    }
}

void PersonTracker::processDetection(
    const Frame& frame,
    const std::shared_ptr<DetectionInternal>& detection)
{
    const int64_t cvTrackId = detection->cvTrackId;
    TrackPtr track = getOrCreateTrack(m_idMapper->get(cvTrackId));

    track->addDetection(frame.timestampUs, detection->detection);

    const Status trackStatus = track->status();

    if (trackStatus == Status::started)
        copyDetectionsHistoryToTrack(frame, cvTrackId, track.get());
}

void PersonTracker::processDetections(
    const Frame& frame,
    const DetectionInternalList& detectionsInternal)
{
    for (const DetectionInternalPtr& detection: detectionsInternal)
        processDetection(frame, detection);
}

EventList PersonTracker::generateEvents()
{
    if (m_tracks.empty())
        return {};

    EventList result;
    bool allTracksAreFinished = true;

    for (const auto& pair: m_tracks)
    {
        const TrackPtr& track = pair.second;

        if (track->status() == Status::started)
        {
            track->activate();

            const auto objectEnterEvent = std::make_shared<PersonDetected>(PersonDetected{
                track->detections[0]->timestampUs,
                track->id(),
            });
            result.push_back(objectEnterEvent);

            if (!m_personDetectionStartTimestampUs)
            {
                const auto timestampUs = track->detections[0]->timestampUs;
                result.push_back(std::make_shared<PeopleDetected>(timestampUs));

                m_personDetectionStartTimestampUs = timestampUs;
            }

            allTracksAreFinished = false;
        }
        else if (track->status() == Status::finished)
        {
            const auto event = std::make_shared<PersonLost>(PersonLost{
                track->detections[track->detections.size() - 1]->timestampUs,
                track->id(),
            });
            result.push_back(event);
        }
        else
        {
            allTracksAreFinished = false;
        }
    }

    if (m_personDetectionStartTimestampUs && allTracksAreFinished)
    {
        const auto& track = m_tracks.begin()->second;
        const auto timestampUs = track->detections[track->detections.size() - 1]->timestampUs;
        result.push_back(std::make_shared<PeopleDetected>(
            timestampUs, timestampUs - *m_personDetectionStartTimestampUs));

        m_personDetectionStartTimestampUs = std::nullopt;
    }

    return result;
}

PersonTracker::PersonReIdDescriptor::PersonReIdDescriptor(
    std::filesystem::path modelDir,
    LogUtils logUtils,
    const std::shared_ptr<const Config> config):
    m_personReId(std::make_shared<PersonReId>(
        /*modelDir*/ modelDir,
        /*logUtils*/ logUtils,
        /*config*/ config))
{
}

Size PersonTracker::PersonReIdDescriptor::size() const
{
    return {
        /*_width*/ PersonReId::kChannelCount,
        /*_height*/ 1,
    };
}

void PersonTracker::PersonReIdDescriptor::compute(const Mat& mat, Mat& descriptor)
{
    m_personReId->run(mat).copyTo(descriptor);
}

void PersonTracker::PersonReIdDescriptor::compute(
    const std::vector<Mat>& mats,
    std::vector<Mat>& descriptors)
{
    descriptors.resize(mats.size());
    for (size_t i = 0; i < mats.size(); ++i)
        compute(mats[i], descriptors[i]);
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
