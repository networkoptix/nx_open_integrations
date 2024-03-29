// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# 2-way Audio Communication using Nx API

The Nx Witness API allows third-party web browsers to send audio to a camera and receive audio from a camera, enabling 2-way audio communication through security cameras.

## Using the Sample HTML

The sample HTML provided in the repository demonstrates the functionality of 2-way audio in the browser through the API.

To test the sample, run it, and input your information at the top (including Camera ID). Then, click Connect in the ‘Mic’ section. If your browser asks for microphone permission, allow it.

## Prerequisites

Your camera must support 2-way audio and must be supported by Nx. Please check the [IPVD](https://nxvms.com/ipvd) to confirm that your camera is supported.

### Request Format from Browser to Camera

Use the following format to create a request to be sent from the browser to the camera:

`ws://<server_ip>:<server_port>/api/http_audio?camera_Id=<id>&format=<audio_sample_format>&sample_rate=<audio_sample_rate>&channels=<audio_channels_count>`

When using a raw audio format (PCM), include the parameters below:

* `<audio_sample_format>` — use one of the following formats: u8, s16be, s16le, s32be, s32le, f32be, f32le, f64be, and f64le.
* `<audio_sample_rate>` —  input the desired audio sample rate, which is an integer value.
* `<audio_channels_count>` — use 1 for mono and 2 for stereo.

Note: For audio mixed with a media container (e.g. MP4, WAV, AAC, etc), exclude these parameters from your request.

### Request Format from Camera to Browser

`http://<server_ip>:<server_port>/media/<camera_id>.webm?audio_only`

## Authors

**Network Optix**

## License
This project is licensed under the [Mozilla Public License, v. 2.0](
http://mozilla.org/MPL/2.0/) - see the [LICENSE.md]() file for details.
