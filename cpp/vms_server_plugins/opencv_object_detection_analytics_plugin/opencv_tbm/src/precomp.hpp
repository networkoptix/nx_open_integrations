// This file is part of OpenCV project.
// It is subject to the license terms in the LICENSE file found in the top-level directory
// of this distribution and at http://opencv.org/license.html.

// Replaces opencv_contrib's modules/tracking/src/precomp.hpp, which pulls in the whole tracking
// module: Tracking-by-Matching only needs core and imgproc.

#pragma once

#include "opencv2/core.hpp"
#include "opencv2/imgproc.hpp"
#include "opencv2/tracking/tracking_by_matching.hpp" //< Declares cv::detail::tracking.

// Kept from the original precomp.hpp: makes cv::detail::tracking names (e.g. cv::tbm) visible
// in cv.
namespace cv { inline namespace tracking {
namespace impl { }
using namespace impl;
using namespace cv::detail::tracking;
}}  // namespace
