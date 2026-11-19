# OpenCV Tracking-by-Matching

The Tracking-by-Matching (`cv::detail::tracking::tbm`) part of the OpenCV contrib `tracking`
module, used by steps 4 and 5. OpenCV comes from Conan: from the Nx Conan remote (the default on
Linux) or prebuilt from ConanCenter (the default on Windows); see
[Dependencies](../readme.md#dependencies).
Both are used with the recipe's `tracking` option off (its default), so neither includes the
contrib `tracking` module. The sources are bundled here instead and built as a static library by
`opencv_tbm.cmake`.

Source: [opencv_contrib 4.10.0](https://github.com/opencv/opencv_contrib/tree/4.10.0/modules/tracking),
the same version as the OpenCV package:

- `include/opencv2/tracking/tracking_by_matching.hpp`
- `src/tracking_by_matching.cpp`, `src/kuhn_munkres.cpp`, `src/kuhn_munkres.hpp`

`src/precomp.hpp` is replaced with a minimal one including only `core` and `imgproc`.

Licensed under the Apache License 2.0, see `LICENSE`.
