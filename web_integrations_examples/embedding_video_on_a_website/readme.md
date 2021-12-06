// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Embedding Video from the VMS on a Website

Embedding a video from an Nx Witness system into a browser has many use cases — sharing a livestream, building an external interface for integrated products, etc.

## Using the Sample HTML
The sample HTML file in the repository opens a simple web page that has embedded video pulled from Nx Server. The file is an implementation of several important steps such as URL-based authentication, video link generation, video player selection, and cloud implementation.

For an in-depth guide on embedding video on your webpage, visit [our Knowledgebase](https://support.networkoptix.com/hc/en-us/articles/360019770334-How-to-Embed-Video-from-Nx-Witness-Nx-Meta-on-a-website).

#### Prerequisites

Install the following libraries:

* MD5 generator: https://github.com/blueimp/JavaScript-MD5 (you can use any alternative library)
* HLS player: https://github.com/video-dev/hls.js/

#### Best Security Practices

* When you embed the video on a website, always create a dedicated user with limited permissions (ideally, only live viewing for specific public cameras).
* It is better to generate the link on the server-side (backend) to avoid sending passwords with source code to the browser.

### Quick Start Guide
To test the HTML sample, replace the following generic variables with your information:

```
var username = 'user@example.com';
var password = 'password123';
var cameraId = 'a02d3776-a7eb-faea-97d5-6251c1694151';
var serverAddress = "https://127.0.0.1:7001";
```

#### Technical Limitations & Overcoming Them Using Nx Cloud

* The video will work only if the browser can reach the system. If you are using your server’s IP address, the video will not be accessible outside of the local network.
* If you embed the video on the secure website (using HTTPS), requests might not work because the browser doesn’t trust the server’s self-signed certificate.
* The browser may have a limit of 5-7 connections per domain.

To overcome these limitations, we use [Nx Cloud relay](https://support.networkoptix.com/hc/en-us/articles/360016266074-Cloud-API-Route-API-Calls-via-Nx-Cloud) in the HTML sample.

## Authors

**Network Optix**

## License
This project is licensed under the [Mozilla Public License, v. 2.0](
http://mozilla.org/MPL/2.0/) - see the [LICENSE.md]() file for details.
