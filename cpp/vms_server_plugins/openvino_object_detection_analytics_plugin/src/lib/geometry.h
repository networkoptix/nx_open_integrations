// Copyright 2019-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

#pragma once

#include <chrono>

#include <boost/geometry/algorithms/centroid.hpp>
#include <boost/geometry/algorithms/correct.hpp>
#include <boost/geometry/algorithms/intersects.hpp>
#include <boost/geometry/algorithms/intersection.hpp>
#include <boost/geometry/geometries/box.hpp>
#include <boost/geometry/geometries/linestring.hpp>
#include <boost/geometry/geometries/point_xy.hpp>
#include <boost/geometry/geometries/polygon.hpp>
#include <boost/geometry/geometries/segment.hpp>
#include <boost/geometry/strategies/strategies.hpp>
#include <opencv2/core/core.hpp>

#include <nx/kit/json.h>
#include <nx/sdk/analytics/rect.h>
#include <boost/optional.hpp>

#include "settings.h"

namespace nx::vms_server_plugins::analytics::openvino_object_detection {

enum class Direction
{
    none,
    left,
    right,
    absent,
};

namespace bg = boost::geometry;

using Point = bg::model::d2::point_xy<float, bg::cs::cartesian>;
using Line = bg::model::segment<Point>;
using Rect = bg::model::box<Point>;
using Polyline = bg::model::linestring<Point>;
using Polygon = bg::model::polygon<Point>;

class RoiLine
{
public:
    static constexpr int kMaxCount = 10;
    static constexpr int kMaxPoints = 20;

    Polyline value;
    Direction direction = Direction::none;
    int index = 0;
    std::string name;
};

using namespace std::chrono_literals;

class RoiArea
{
public:
    static constexpr int kMaxCount = 10;
    static constexpr int kMaxPoints = 30;

public:
    inline Point getCentroid() const
    {
        if (!m_centroid)
            m_centroid = boost::make_optional<Point>(bg::return_centroid<Point>(value));
        return m_centroid.value();
    }

public:
    Polygon value;
    int index = 0;
    std::string name;

    bool entranceDetectionEnabled =
        settings::roi_area::entrance_detection_enabled::kDefault;

    bool exitDetectionEnabled =
        settings::roi_area::exit_detection_enabled::kDefault;

    bool appearanceDetectionEnabled =
        settings::roi_area::appearance_detection_enabled::kDefault;

    bool disappearanceDetectionEnabled =
        settings::roi_area::disappearance_detection_enabled::kDefault;

    bool loiteringDetectionEnabled =
        settings::roi_area::loitering_detection_enabled::kDefault;

    bool crossingEnabled =
        settings::roi_area::crossing_enabled::kDefault;

    float detectionSensitivity =
        settings::roi_area::detection_sensitivity::kDefault;

    std::chrono::seconds loiteringDetectionDuration =
        settings::roi_area::loitering_detection_duration::kDefault;

private:
    mutable boost::optional<Point> m_centroid;
};

using RoiLinePtr = std::shared_ptr<RoiLine>;
using RoiAreaPtr = std::shared_ptr<RoiArea>;
using RoiAreaConstPtr = std::shared_ptr<const RoiArea>;

using PointList = std::vector<Point>;
using RoiLineList = std::vector<RoiLinePtr>;
using RoiAreaList = std::vector<RoiAreaPtr>;

inline Direction intersectionDirection(Line line0, Line line1) noexcept
{
    const float line0x = line0.second.x() - line0.first.x();
    const float line0y = line0.second.y() - line0.first.y();
    const float line1x = line1.second.x() - line1.first.x();
    const float line1y = line1.second.y() - line1.first.y();
    return (line0x * line1y - line0y * line1x > 0) ? Direction::left : Direction::right;
}

inline Direction intersectionDirection(const Polyline& polyline, Line line) noexcept
{
    Direction result = Direction::none;
    for (int i = 0; i != polyline.size() - 1; ++i)
    {
        const Line polylineSegment = {polyline.at(i), polyline.at(i + 1)};
        if (bg::intersects(line, polylineSegment))
        {
            const Direction direction = intersectionDirection(line, polylineSegment);
            if (result == Direction::none)
                result = direction;
            else if (direction != result)
                result = Direction::absent;
        }
    }
    return result;
}

inline Point lineDirection(Line line)
{
    return Point(line.second.x() - line.first.x(), line.second.y() - line.first.y());
}

inline Point lineOrthogonalDirection(Line line)
{
    Point direction = lineDirection(line);
    return Point(-direction.y(), direction.x());
}

inline Line linePerpendicular(Line line, Point point)
{
    Point orthogonalDirection = lineOrthogonalDirection(line);
    Point secondPoint = Point(
        point.x() + orthogonalDirection.x(),
        point.y() + orthogonalDirection.y());
    return Line(point, secondPoint);
}

inline Point linesIntersectionPoint(Line line0, Line line1)
{
    double x1 = line0.first.x();
    double x2 = line0.second.x();
    double y1 = line0.first.y();
    double y2 = line0.second.y();
    double x3 = line1.first.x();
    double x4 = line1.second.x();
    double y3 = line1.first.y();
    double y4 = line1.second.y();
    double denominator = (x1 - x2)*(y3 - y4) - (y1 - y2)*(x3 - x4);
    double x = ((x1*y2 - y1*x2)*(x3 - x4) - (x1 - x2)*(x3*y4 - y3*x4)) / denominator;
    double y = ((x1*y2 - y1*x2)*(y3 - y4) - (y1 - y2)*(x3*y4 - y3*x4)) / denominator;
    return Point((float) x, (float) y);
}

inline boost::optional<Point> lineSegmentIntersectionPoint(Line line, Line segment)
{
    Point linesIntersection = linesIntersectionPoint(line, segment);
    if (bg::within(linesIntersection, bg::return_envelope<Rect>(segment)))
        return boost::make_optional(linesIntersection);
    else
        return {};
}

inline float rectFractionInsidePolygon(Rect rect, const Polygon& polygon)
{
    std::deque<Polygon> intersection;
    bg::intersection(rect, polygon, intersection);
    if (intersection.empty())
        return 0.0F;

    Polygon& intersectionPolygon = *intersection.begin();
    return (float) (bg::area(intersectionPolygon) / bg::area(rect));
}

inline cv::Rect convertBoostRectToCvRect(Rect rect, int width, int height)
{
    return cv::Rect(
        /*x*/ (int) (rect.min_corner().x() * width),
        /*y*/ (int) (rect.min_corner().y() * height),
        /*width*/ (int) ((rect.max_corner().x() - rect.min_corner().x()) * width),
        /*height*/ (int) ((rect.max_corner().y() - rect.min_corner().y()) * height)) &
        cv::Rect(/*x*/ 0, /*y*/ 0, /*width*/ width, /*height*/ height);
}

inline nx::sdk::analytics::Rect convertBoostRectToNxRect(Rect rect)
{
    return {
        /*x*/ rect.min_corner().x(),
        /*y*/ rect.min_corner().y(),
        /*width*/ rect.max_corner().x() - rect.min_corner().x(),
        /*height*/ rect.max_corner().y() - rect.min_corner().y(),
    };
}

inline Rect convertCvRectToBoostRect(cv::Rect rect, int width, int height)
{
    float xMin = (float) rect.x / width;
    float yMin = (float) rect.y / height;
    float xMax = xMin + (float) rect.width / width;
    float yMax = yMin + (float) rect.height / height;
    return {
        /*min_corner*/ { xMin, yMin },
        /*max_corner*/ { xMax, yMax },
    };
}

template<class Geometry>
inline std::shared_ptr<Geometry> convertJsonStringToGeometry(const std::string& jsonString)
{
    std::string parsingError;
    const auto json = nx::kit::Json::parse(jsonString, parsingError);
    const auto figureJson = json["figure"];
    const auto pointsJson = figureJson["points"];
    const auto result = std::make_shared<Geometry>();
    for (const auto& pointJsonArray: pointsJson.array_items())
    {
        const auto x = (float) pointJsonArray[0].number_value();
        const auto y = (float) pointJsonArray[1].number_value();
        bg::append(result->value, Point(x, y));
    }
    result->name = json["label"].string_value();
    return bg::is_empty(result->value) ? nullptr : result;
}

inline RoiLinePtr convertJsonStringToRoiLinePtr(const std::string& jsonString)
{
    auto result = convertJsonStringToGeometry<RoiLine>(jsonString);
    if (!result)
        return nullptr;

    std::string parsingError;
    const auto json = nx::kit::Json::parse(jsonString, parsingError);
    const auto figureJson = json["figure"];
    const std::string direction = figureJson["direction"].string_value();
    if (direction == "left")
        result->direction = Direction::left;
    else if (direction == "right")
        result->direction = Direction::right;
    else
        result->direction = Direction::absent;
    return result;
}

inline RoiAreaPtr convertJsonStringToRoiAreaPtr(const std::string& jsonString)
{
    RoiAreaPtr result = convertJsonStringToGeometry<RoiArea>(jsonString);
    if (result)
        bg::correct(result->value);
    return result;
}

} // namespace nx::vms_server_plugins::analytics::openvino_object_detection
