// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#include "object_tracker.h"

#include <opencv2/core/core.hpp>

#include "exceptions.h"

namespace sample_company {
namespace vms_server_plugins {
namespace opencv_object_detection {

using namespace std::string_literals;

using namespace cv;
using namespace cv::detail::tracking::tbm;

using namespace nx::sdk;
using namespace nx::sdk::analytics;

/**
 * This function implementation is based on the sample from opencv_contrib repository:
 * https://github.com/opencv/opencv_contrib/blob/0a2179b328/modules/tracking/samples/tracking_by_matching.cpp
 */
cv::Ptr<ITrackerByMatching> createTrackerByMatchingWithFastDescriptor()
{
    TrackerParams params;

    // Real forget delay is `params.forget_delay * kDetectionFramePeriod`.
    params.forget_delay = 75;

    // Keep forgotten tracks for cleaning up our tracks and dropping cv::detail::tracking::tbm tracks manually.
    params.drop_forgotten_tracks = false;

    cv::Ptr<ITrackerByMatching> tracker = createTrackerByMatching(params);

    static const Size kDescriptorFastSize(16, 32);
    std::shared_ptr<IImageDescriptor> descriptorFast =
        std::make_shared<ResizedImageDescriptor>(
            kDescriptorFastSize, InterpolationFlags::INTER_LINEAR);
    std::shared_ptr<IDescriptorDistance> distanceFast =
        std::make_shared<MatchTemplateDistance>();

    tracker->setDescriptorFast(descriptorFast);
    tracker->setDistanceFast(distanceFast);

    return tracker;
}

class ObjectTracker::Track
{
public:
    enum class Status { inactive, started, active, finished };

public:
    explicit Track(int maxDetectionCount): m_maxDetectionCount(maxDetectionCount) {}

    void addDetection(
        int64_t timestampUs,
        const std::shared_ptr<const Detection>& detection,
        bool isTrackStarted = true)
    {
        if (m_detections.size() == (size_t) m_maxDetectionCount)
            m_detections.erase(m_detections.begin());

        if (isTrackStarted)
        {
            if (m_status == Status::inactive)
                m_status = Status::started;
            else if (m_status == Status::started)
                m_status = Status::active;
        }

        m_detections.insert(std::make_pair(timestampUs, detection));
    }

    Status status() const { return m_status; }
    int64_t startTimeUs() const { return m_detections.begin()->first; }
    std::string classLabel() const { return m_detections.begin()->second->classLabel; };

private:
    std::map<
       /*timestampUs*/ int64_t,
       /*detection*/ std::shared_ptr<const Detection>
    > m_detections;

    Status m_status = Status::inactive;
    int m_maxDetectionCount;
};

//-------------------------------------------------------------------------------------------------
// public

ObjectTracker::ObjectTracker():
    m_tracker(createTrackerByMatchingWithFastDescriptor())
{
    for (const std::string& classLabel: kClassesToDetect)
        m_detectionActive[classLabel] = false;
}

ObjectTracker::Result ObjectTracker::run(const Frame& frame, const DetectionList& detections)
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
        throw ObjectTrackingError("Error: "s + e.what());
    }
}

//-------------------------------------------------------------------------------------------------
// private

EventList ObjectTracker::generateDetectionFinishedEvents(int64_t timestampUs)
{
    EventList result;
    for (const std::string& classLabel: kClassesToDetect)
    {
        if (m_detectionActive[classLabel])
        {
            bool noActiveTracks = true;
            for (const auto& pair: m_tracks)
            {
                const std::shared_ptr<Track> track = pair.second;
                if (track->classLabel() == "person")
                {
                    noActiveTracks = false;
                    break;
                }
            }

            if (noActiveTracks)
            {
                result.push_back(std::make_shared<Event>(Event{
                    /*eventType*/ EventType::detection_finished,
                    /*timestampUs*/ timestampUs,
                    /*classLabel*/ classLabel,
                }));
                m_detectionActive[classLabel] = false;
            }
        }
    }
    return result;
}

void ObjectTracker::copyDetectionsHistoryToTrack(
    const Frame& frame,
    int64_t cvTrackId,
    Track* track,
    const std::string& classLabel) const
{
    const cv::detail::tracking::tbm::Track& cvTrack = m_tracker->tracks().at((size_t) cvTrackId);
    for (const TrackedObject& trackedDetection: cvTrack.objects)
    {
        if ((int64_t) trackedDetection.timestamp == frame.timestampUs)
            break;

        std::shared_ptr<const DetectionInternal> detection = convertTrackedObjectToDetection(
            /*frame*/ frame,
            /*trackedDetection*/ trackedDetection,
            /*classLabel*/ classLabel,
            /*idMapper*/ m_idMapper.get());
        track->addDetection(
            /*timestampUs*/ (int64_t) trackedDetection.timestamp,
            /*detection*/ detection->detection,
            /*isTrackStarted*/ false);
    }
}

std::shared_ptr<ObjectTracker::Track> ObjectTracker::getOrCreateTrack(const Uuid& trackId)
{
    std::shared_ptr<Track> result;
    if (m_tracks.find(trackId) == m_tracks.end())
    {
        result = std::make_shared<Track>(m_tracker->params().max_num_objects_in_track);
        m_tracks.insert(std::make_pair(trackId, result));
    }
    else
    {
        result = m_tracks[trackId];
    }
    return result;
}

EventList ObjectTracker::processDetection(
    const Frame& frame,
    const std::shared_ptr<DetectionInternal>& detection)
{
    EventList events;
    const int64_t cvTrackId = detection->cvTrackId;
    std::shared_ptr<Track> track = getOrCreateTrack(m_idMapper->get(cvTrackId));

    const bool isTrackStarted = m_tracker->isTrackValid((size_t) cvTrackId);
    track->addDetection(
        /*timestampUs*/ frame.timestampUs,
        /*detection*/ detection->detection,
        /*isTrackStarted*/ isTrackStarted);

    const Track::Status& trackStatus = track->status();

    if (trackStatus == Track::Status::started)
    {
        const std::string classLabel = detection->detection->classLabel;

        copyDetectionsHistoryToTrack(
            /*frame*/ frame,
            /*cvTrackId*/ cvTrackId,
            /*track*/ track.get(),
            /*classLabel*/ classLabel);

        events.push_back(std::make_shared<Event>(Event{
            /*eventType*/ EventType::object_detected,
            /*timestampUs*/ track->startTimeUs(),
            /*classLabel*/ classLabel,
        }));
    }

    const std::string& classLabel = detection->detection->classLabel;
    if ((trackStatus == Track::Status::started || trackStatus == Track::Status::active) &&
        std::find(kClassesToDetect.begin(), kClassesToDetect.end(), classLabel) !=
        kClassesToDetect.end())
    {
        if (!m_detectionActive[classLabel])
        {
            events.push_back(std::make_shared<Event>(Event{
                /*eventType*/ EventType::detection_started,
                /*timestampUs*/ track->startTimeUs(),
                /*classLabel*/ classLabel,
            }));
            m_detectionActive[classLabel] = true;
        }
    }

    return events;
}

EventList ObjectTracker::generateEvents(
    const Frame& frame,
    const DetectionInternalList& detectionsInternal)
{
    EventList result;
    for (const std::shared_ptr<DetectionInternal>& detection: detectionsInternal)
    {
        EventList events = processDetection(
            /*frame*/ frame,
            /*detection*/ detection);
        result.insert(
            result.end(),
            std::make_move_iterator(events.begin()),
            std::make_move_iterator(events.end()));
    }

    cleanup();

    const EventList detectionFinishedEvents = generateDetectionFinishedEvents(frame.timestampUs);
    result.insert(
        result.end(),
        std::make_move_iterator(detectionFinishedEvents.begin()),
        std::make_move_iterator(detectionFinishedEvents.end()));

    return result;
}

ObjectTracker::Result ObjectTracker::runImpl(
    const Frame& frame,
    const DetectionList& detections)
{
    // Unfortunately the OpenCV tbm module does not support preserving classLabel during tracking.
    // See issue: https://github.com/opencv/opencv_contrib/issues/2298
    // Therefore, we save information about classLabels in the map from unique id of the detection
    // (bounding box + timestamp) to classLabel.
    std::map<const CompositeDetectionId, std::string> classLabels;

    TrackedObjects detectionsToTrack = convertDetectionsToTrackedObjects(
        /*frame*/ frame,
        /*detections*/ detections,
        /*classLabels*/ &classLabels);

    // Perform tracking and extract tracked detections.
    m_tracker->process(frame.cvMat, detectionsToTrack, (uint64_t) frame.timestampUs);
    const TrackedObjects trackedDetections = m_tracker->trackedDetections();

    DetectionInternalList detectionsInternal =
        convertTrackedObjectsToDetections(
        /*frame*/ frame,
        /*trackedDetections*/ trackedDetections,
        /*classLabels*/ classLabels,
        /*idMapper*/ m_idMapper.get());

    EventList events = generateEvents(
        /*frame*/ frame,
        /*detectionsInternal*/ detectionsInternal);

    return {
        /*detections*/ extractDetectionList(detectionsInternal),
        /*events*/ std::move(events),
    };
}

/**
 * Cleanup ids of the objects that belong to the forgotten tracks.
 */
void ObjectTracker::cleanupIds()
{
    std::set<Uuid> validIds;
    for (const auto& pair: m_tracks)
        validIds.insert(pair.first);
    m_idMapper->removeAllExcept(validIds);
}

void ObjectTracker::cleanupTracks()
{
    for (const auto& pair: m_tracker->tracks())
    {
        auto cvTrackId = (int64_t) pair.first;
        if (m_tracker->isTrackForgotten((size_t) cvTrackId))
        {
            const cv::detail::tracking::tbm::Track& cvTrack = pair.second;
            const Uuid& trackId = m_idMapper->get(cvTrack.first_object.object_id);
            m_tracks.erase(trackId);
        }
    }
}

void ObjectTracker::cleanup()
{
    cleanupTracks();
    m_tracker->dropForgottenTracks();
    cleanupIds();
}

} // namespace opencv_object_detection
} // namespace vms_server_plugins
} // namespace sample_company
