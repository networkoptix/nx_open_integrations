#!/usr/bin/env python
# -*- coding: utf-8 -*-
from conans import ConanFile, CMake, tools
from conans.model.version import Version
from conans.errors import ConanInvalidConfiguration
import os


class OpenCVConan(ConanFile):
    name = "opencv"
    version = "4.1.1"
    license = "BSD-3-Clause"
    homepage = "https://github.com/opencv/opencv"
    url = "https://github.com/conan-community/conan-opencv"
    author = "Conan Community"
    topics = ("conan", "opencv", "computer-vision",
              "image-processing", "deep-learning")
    settings = "os", "compiler", "build_type", "arch"
    options = {"shared": [True, False],
               "fPIC": [True, False],
               "contrib": [True, False],
               "jpeg": [True, False],
               "jpegturbo": [True, False],
               "tiff": [True, False],
               "webp": [True, False],
               "png": [True, False],
               "jasper": [True, False],
               "openexr": [True, False],
               "gtk": [None, 2, 3],
               "nonfree": [True, False],
               "dc1394": [True, False],
               "carotene": [True, False],
               "cuda": [True, False],
               "protobuf": [True, False],
               "freetype": [True, False],
               "harfbuzz": [True, False],
               "eigen": [True, False],
               "glog": [True, False],
               "gflags": [True, False],
               "gstreamer": [True, False],
               "openblas": [True, False],
               "ffmpeg": [True, False],
               "lapack": [True, False],
               "quirc": [True, False]}
    default_options = {"shared": False,
                       "fPIC": True,
                       "contrib": True,
                       "jpeg": False,
                       "jpegturbo": False,
                       "tiff": False,
                       "webp": False,
                       "png": False,
                       "jasper": False,
                       "openexr": False,
                       "gtk": None,
                       "nonfree": False,
                       "dc1394": False,
                       "carotene": False,
                       "cuda": False,
                       "protobuf": True,
                       "freetype": False,
                       "harfbuzz": False,
                       "eigen": False,
                       'glog': False,
                       "gflags": False,
                       "gstreamer": False,
                       "openblas": False,
                       "ffmpeg": False,
                       "lapack": False,
                       "quirc": False}
    exports_sources = ["CMakeLists.txt", "patches/*.patch"]
    exports = "LICENSE"
    generators = "cmake"
    description = "OpenCV is an open source computer vision and machine learning software library."
    short_paths = True
    _source_subfolder = "source_subfolder"
    _build_subfolder = "build_subfolder"

    def configure(self):
        compiler_version = Version(self.settings.compiler.version.value)
        if self.settings.compiler == "Visual Studio" and compiler_version < "14":
            raise ConanInvalidConfiguration(
                "OpenCV 4.x requires Visual Studio 2015 and higher")
        if self.options.cuda and not self.options.contrib:
            raise ConanInvalidConfiguration(
                "opencv:cuda requires opencv:contrib")
        if not self.options.contrib:
            del self.options.freetype
            del self.options.harfbuzz
            del self.options.glog
            del self.options.gflags

    def source(self):
        sha256 = "5de5d96bdfb9dad6e6061d70f47a0a91cee96bb35afb9afb9ecb3d43e243d217"
        tools.get("{}/archive/{}.tar.gz".format(self.homepage, self.version), sha256=sha256)
        os.rename('opencv-%s' % self.version, self._source_subfolder)

        sha256 = "9f85d380758498d800fec26307e389620cde8b1a2e86ab51cddc5200fbe37102"
        tools.get("https://github.com/opencv/opencv_contrib/archive/{}.tar.gz".format(self.version), sha256=sha256)
        os.rename('opencv_contrib-%s' % self.version, 'contrib')

        for directory in ['libjasper', 'libjpeg-turbo', 'libjpeg', 'libpng', 'libtiff',
                    'libwebp', 'openexr', 'protobuf', 'zlib']:
            tools.rmdir(os.path.join(self._source_subfolder, '3rdparty', directory))

    def config_options(self):
        if self.settings.os == 'Windows':
            del self.options.fPIC
        if self.settings.os != 'Linux':
            del self.options.gtk

    def system_requirements(self):
        if self.settings.os == 'Linux' and tools.os_info.is_linux:
            if tools.os_info.with_apt:
                installer = tools.SystemPackageTool()
                arch_suffix = ''
                if self.settings.arch == 'x86':
                    arch_suffix = ':i386'
                elif self.settings.arch == 'x86_64':
                    arch_suffix = ':amd64'
                packages = []
                if self.options.gtk == 2:
                    packages.append('libgtk2.0-dev%s' % arch_suffix)
                elif self.options.gtk == 3:
                    packages.append('libgtk-3-dev%s' % arch_suffix)
                for package in packages:
                    installer.install(package)
            elif tools.os_info.with_yum:
                installer = tools.SystemPackageTool()
                arch_suffix = ''
                if self.settings.arch == 'x86':
                    arch_suffix = '.i686'
                elif self.settings.arch == 'x86_64':
                    arch_suffix = '.x86_64'
                packages = []
                if self.options.gtk == 2:
                    packages.append('gtk2-devel%s' % arch_suffix)
                elif self.options.gtk == 3:
                    packages.append('gtk3-devel%s' % arch_suffix)
                for package in packages:
                    installer.install(package)

    def requirements(self):
        self.requires.add('zlib/1.2.11@conan/stable')
        if self.options.jpeg:
            # NOTE : use the same libjpeg implementation as jasper uses
            # otherwise, jpeg_create_decompress will fail on version check
            if self.options.jpegturbo:
                self.requires.add('libjpeg-turbo/1.5.2@bincrafters/stable')
            else:
                self.requires.add('libjpeg/9c@bincrafters/stable')
        if self.options.tiff:
            self.requires.add('libtiff/4.0.9@bincrafters/stable')
        if self.options.webp:
            self.requires.add('libwebp/1.0.3@bincrafters/stable')
        if self.options.png:
            self.requires.add('libpng/1.6.37@bincrafters/stable')
        if self.options.jasper:
            self.requires.add('jasper/2.0.14@conan/stable')
            self.options["jasper"].jpegturbo = self.options.jpegturbo
        if self.options.openexr:
            self.requires.add('openexr/2.3.0@conan/stable')
        if self.options.protobuf:
            # NOTE : version should be the same as used in OpenCV release,
            # otherwise, PROTOBUF_UPDATE_FILES should be set to re-generate files
            self.requires.add('protobuf/3.5.2@bincrafters/stable')
        if self.options.eigen:
            self.requires.add('eigen/3.3.7@conan/stable')
        if self.options.gstreamer:
            self.requires.add('gstreamer/1.16.0@bincrafters/stable')
            self.requires.add('gst-plugins-base/1.16.0@bincrafters/stable')
        if self.options.openblas:
            self.requires.add('openblas/0.3.5@conan/stable')
        if self.options.ffmpeg:
            self.requires.add('ffmpeg/4.2@bincrafters/stable')
        if self.options.lapack:
            self.requires.add('lapack/3.7.1@conan/stable')
        if self.options.contrib:
            if self.options.freetype:
                self.requires.add('freetype/2.10.0@bincrafters/stable')
            if self.options.harfbuzz:
                self.requires.add('harfbuzz/2.4.0@bincrafters/stable')
            if self.options.glog:
                self.requires.add('glog/0.4.0@bincrafters/stable')
            if self.options.gflags:
                self.requires.add('gflags/2.2.2@bincrafters/stable')

    def _configure_cmake(self):
        cmake = CMake(self)

        # General configuration
        cmake.definitions['OPENCV_CONFIG_INSTALL_PATH'] = "cmake"
        cmake.definitions['OPENCV_BIN_INSTALL_PATH'] = "bin"
        cmake.definitions['OPENCV_LIB_INSTALL_PATH'] = "lib"
        cmake.definitions['OPENCV_3P_LIB_INSTALL_PATH'] = "lib"
        cmake.definitions['OPENCV_OTHER_INSTALL_PATH'] = "res"
        cmake.definitions['OPENCV_LICENSES_INSTALL_PATH'] = "licenses"
        cmake.definitions['BUILD_opencv_apps'] = False

        # Compiler configuration
        if self.settings.compiler == 'Visual Studio':
            cmake.definitions['BUILD_WITH_STATIC_CRT'] = 'MT' in str(
                self.settings.compiler.runtime)

        cmake.definitions['WITH_DSHOW'] = self.settings.compiler == 'Visual Studio'
        # MinGW doesn't build wih Media Foundation
        cmake.definitions['WITH_MSMF'] = self.settings.compiler == 'Visual Studio'
        cmake.definitions['WITH_MSMF_DXVA'] = self.settings.compiler == 'Visual Studio'

        if self.settings.os != 'Windows':
            cmake.definitions['ENABLE_PIC'] = self.options.fPIC

        # We are building C++ only. Disable other languages
        cmake.definitions['BUILD_JAVA'] = False
        cmake.definitions['BUILD_opencv_java_bindings_generator'] = False
        cmake.definitions['BUILD_opencv_js'] = False
        cmake.definitions['BUILD_opencv_python2'] = False
        cmake.definitions['BUILD_opencv_python3'] = False
        cmake.definitions['BUILD_opencv_python_bindings_generator'] = False
        cmake.definitions['BUILD_opencv_python_tests'] = False

        # Don't build tests
        cmake.definitions['BUILD_TESTS'] = False
        cmake.definitions['BUILD_PERF_TESTS'] = False
        cmake.definitions['BUILD_opencv_ts'] = False
        cmake.definitions['INSTALL_TESTS'] = False

        # Don't install docs and examples
        cmake.definitions['BUILD_DOCS'] = False
        cmake.definitions['BUILD_EXAMPLES'] = False
        cmake.definitions['INSTALL_C_EXAMPLES'] = False
        cmake.definitions['INSTALL_PYTHON_EXAMPLES'] = False

        # 3rd-party libraries and configurations

        # Disable builds for all 3rd-party components, use libraries from conan only
        cmake.definitions['OPENCV_FORCE_3RDPARTY_BUILD'] = False

        # IEEE1394
        cmake.definitions["WITH_1394"] = self.options.dc1394

        # NVidia Carotene
        cmake.definitions['WITH_CAROTENE'] = self.options.carotene

        # Eigen
        cmake.definitions['WITH_EIGEN'] = self.options.eigen

        # FFMPEG
        cmake.definitions['WITH_FFMPEG'] = self.options.ffmpeg
        if self.options.ffmpeg:
            cmake.definitions['HAVE_FFMPEG'] = True
            cmake.definitions['HAVE_FFMPEG_WRAPPER'] = False
            cmake.definitions['OPENCV_FFMPEG_SKIP_BUILD_CHECK'] = True
            cmake.definitions['OPENCV_FFMPEG_SKIP_DOWNLOAD'] = True
            cmake.definitions['OPENCV_FFMPEG_USE_FIND_PACKAGE'] = False
            cmake.definitions['OPENCV_INSTALL_FFMPEG_DOWNLOAD_SCRIPT'] = False
            for lib in ['avcodec', 'avformat', 'avutil', 'swscale', 'avresample']:
                cmake.definitions['FFMPEG_lib%s_VERSION' % lib] = self.deps_cpp_info['ffmpeg'].version
            cmake.definitions['FFMPEG_LIBRARIES'] = ';'.join(self.deps_cpp_info['ffmpeg'].libs)
            cmake.definitions['FFMPEG_INCLUDE_DIRS'] = ';'.join(self.deps_cpp_info['ffmpeg'].include_paths)

        # GStreamer
        cmake.definitions['WITH_GSTREAMER'] = self.options.gstreamer
        if self.options.gstreamer:
            cmake.definitions['HAVE_GSTREAMER'] = True
            cmake.definitions['GSTREAMER_VERSION'] = self.deps_cpp_info['gstreamer'].version
            libs = []
            includes = []
            for dep in ['pcre', 'libffi', 'gettext', 'glib', 'gstreamer', 'gst-plugins-base']:
                if dep in self.deps_cpp_info.deps:
                    libs.extend(self.deps_cpp_info[dep].libs)
                    includes.extend(self.deps_cpp_info[dep].include_paths)
            cmake.definitions['GSTREAMER_LIBRARIES'] = ';'.join(libs)
            cmake.definitions['GSTREAMER_INCLUDE_DIRS'] = ';'.join(includes)

        # Intel IPP
        cmake.definitions['BUILD_IPP_IW'] = False
        cmake.definitions['BUILD_WITH_DYNAMIC_IPP'] = False
        cmake.definitions['WITH_IPP'] = False

        # Intel ITT
        cmake.definitions['BUILD_ITT'] = False
        cmake.definitions['WITH_ITT'] = False

        # jasper
        cmake.definitions['BUILD_JASPER'] = False
        cmake.definitions['WITH_JASPER'] = self.options.jasper

        # JPEG
        cmake.definitions['BUILD_JPEG'] = False
        cmake.definitions['WITH_JPEG'] = self.options.jpeg

        # LAPACK
        cmake.definitions['WITH_LAPACK'] = self.options.lapack
        if self.options.lapack:
            cmake.definitions['LAPACK_CBLAS_H'] = 'cblas.h'
            cmake.definitions['LAPACK_IMPL'] = 'LAPACK/Generic'
            cmake.definitions['LAPACK_INCLUDE_DIR'] = ';'.join(self.deps_cpp_info['lapack'].include_paths)
            cmake.definitions['LAPACK_LAPACKE_H'] = 'lapacke.h'
            cmake.definitions['LAPACK_LIBRARIES'] = ';'.join(self.deps_cpp_info['lapack'].libs)
            cmake.definitions['LAPACK_LINK_LIBRARIES'] = ';'.join(self.deps_cpp_info['lapack'].lib_paths)

        # OpenEXR
        cmake.definitions['BUILD_OPENEXR'] = False
        cmake.definitions['WITH_OPENEXR'] = self.options.openexr
        if self.options.openexr:
            cmake.definitions['OPENEXR_ROOT'] = self.deps_cpp_info['openexr'].rootpath

        # PNG
        cmake.definitions['BUILD_PNG'] = False
        cmake.definitions['WITH_PNG'] = self.options.png

        # Protobuf
        cmake.definitions['BUILD_PROTOBUF'] = False
        cmake.definitions['PROTOBUF_UPDATE_FILES'] = False
        cmake.definitions['WITH_PROTOBUF'] = self.options.protobuf

        # Intel TBB
        cmake.definitions['BUILD_TBB'] = False
        cmake.definitions['WITH_TBB'] = False

        # quirc
        cmake.definitions['WITH_QUIRC'] = self.options.quirc

        # TIFF
        cmake.definitions['BUILD_TIFF'] = False
        cmake.definitions['WITH_TIFF'] = self.options.tiff

        # WebP
        cmake.definitions['BUILD_WEBP'] = False
        cmake.definitions['WITH_WEBP'] = self.options.webp

        # zlib
        cmake.definitions['BUILD_ZLIB'] = False

        # NVidia CUDA
        cmake.definitions['WITH_CUDA'] = self.options.cuda
        # This allows compilation on older GCC/NVCC, otherwise build errors.
        cmake.definitions['CUDA_NVCC_FLAGS'] = '--expt-relaxed-constexpr'

        # opencv-conrib modules
        if self.options.contrib:
            cmake.definitions['OPENCV_EXTRA_MODULES_PATH'] = os.path.join(self.build_folder, 'contrib', 'modules')
            cmake.definitions['OPENCV_ENABLE_NONFREE'] = self.options.nonfree

            # OpenCV doesn't use find_package for freetype & harfbuzz, so let's specify them
            if self.options.freetype:
                cmake.definitions['FREETYPE_FOUND'] = True
                cmake.definitions['FREETYPE_INCLUDE_DIRS'] = ';'.join(self.deps_cpp_info['freetype'].include_paths)
                cmake.definitions['FREETYPE_LIBRARIES'] = ';'.join(self.deps_cpp_info['freetype'].libs)
            if self.options.harfbuzz:
                cmake.definitions['HARFBUZZ_FOUND'] = True
                cmake.definitions['HARFBUZZ_INCLUDE_DIRS'] = ';'.join(self.deps_cpp_info['harfbuzz'].include_paths)
                cmake.definitions['HARFBUZZ_LIBRARIES'] = ';'.join(self.deps_cpp_info['harfbuzz'].libs)
            if self.options.gflags:
                cmake.definitions['GFLAGS_INCLUDE_DIR_HINTS'] = ';'.join(self.deps_cpp_info['gflags'].include_paths)
                cmake.definitions['GFLAGS_LIBRARY_DIR_HINTS'] = ';'.join(self.deps_cpp_info['gflags'].lib_paths)
            if self.options.glog:
                cmake.definitions['GLOG_INCLUDE_DIR_HINTS'] = ';'.join(self.deps_cpp_info['glog'].include_paths)
                cmake.definitions['GLOG_LIBRARY_DIR_HINTS'] = ';'.join(self.deps_cpp_info['glog'].lib_paths)

        # system libraries
        if self.settings.os == 'Linux':
            cmake.definitions['WITH_GTK'] = self.options.gtk is not None
            cmake.definitions['WITH_GTK_2_X'] = self.options.gtk == 2

        if self.settings.os == 'Android':
            cmake.definitions['ANDROID_STL'] = self.settings.compiler.libcxx
            cmake.definitions['ANDROID_NATIVE_API_LEVEL'] = self.settings.os.api_level

            cmake.definitions['BUILD_ANDROID_EXAMPLES'] = False

            arch = str(self.settings.arch)
            if arch.startswith(('armv7', 'armv8')):
                cmake.definitions['ANDROID_ABI'] = 'NEON'
            else:
                cmake.definitions['ANDROID_ABI'] = {'armv5': 'armeabi',
                                                    'armv6': 'armeabi-v6',
                                                    'armv7': 'armeabi-v7a',
                                                    'armv7hf': 'armeabi-v7a',
                                                    'armv8': 'arm64-v8a'}.get(arch, arch)

            if 'ANDROID_NDK_HOME' in os.environ:
                cmake.definitions['ANDROID_NDK'] = os.environ.get(
                    'ANDROID_NDK_HOME')

        if str(self.settings.os) in ["iOS", "watchOS", "tvOS"]:
            cmake.definitions['IOS'] = True

        cmake.configure(build_folder=self._build_subfolder)
        return cmake

    def build(self):
        # https://github.com/opencv/opencv/issues/8010
        if str(self.settings.compiler) == 'clang' and str(self.settings.compiler.version) == '3.9':
            tools.replace_in_file(os.path.join(self._source_subfolder, 'modules', 'imgproc', 'CMakeLists.txt'),
                                  'ocv_define_module(imgproc opencv_core WRAP java python js)',
                                  'ocv_define_module(imgproc opencv_core WRAP java python js)\n'
                                  'set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/src/'
                                  'imgwarp.cpp PROPERTIES COMPILE_FLAGS "-O0")')

        tools.patch(base_path=self._source_subfolder,
                    patch_file=os.path.join("patches", "0001-fix-FindOpenEXR-to-respect-OPENEXR_ROOT.patch"))
        tools.patch(base_path='contrib',
                    patch_file=os.path.join("patches", "0001-fix-find_package-for-glog-gflags.patch"))

        cmake = self._configure_cmake()
        cmake.build()

    def package(self):
        self.copy("LICENSE", dst="licenses", src=self._source_subfolder)
        cmake = self._configure_cmake()
        cmake.install()
        cmake.patch_config_paths()

    def add_libraries_from_pc(self, library):
        pkg_config = tools.PkgConfig(library)
        libs = [lib[2:] for lib in pkg_config.libs_only_l]  # cut -l prefix
        lib_paths = [lib[2:]
                     for lib in pkg_config.libs_only_L]  # cut -L prefix
        self.cpp_info.libs.extend(libs)
        self.cpp_info.libdirs.extend(lib_paths)
        self.cpp_info.sharedlinkflags.extend(pkg_config.libs_only_other)
        self.cpp_info.exelinkflags.extend(pkg_config.libs_only_other)

    def package_info(self):
        opencv_libs = ["stitching",
                       "photo",
                       "video",
                       "ml",
                       "calib3d",
                       "features2d",
                       "highgui",
                       "videoio",
                       "flann",
                       "imgcodecs",
                       "objdetect",
                       "dnn",
                       "imgproc",
                       "core"]

        if not self.options.protobuf:
            opencv_libs.remove("dnn")

        if self.settings.os != 'Android':
            # gapi depends on ade but ade disabled for Android
            # https://github.com/opencv/opencv/blob/4.0.1/modules/gapi/cmake/DownloadADE.cmake#L2
            opencv_libs.append("gapi")

        if self.options.contrib:
            opencv_libs = [
                "aruco",
                "bgsegm",
                "bioinspired",
                "ccalib",
                "datasets",
                "dpm",
                "face",
                "freetype",
                "fuzzy",
                "hfs",
                "img_hash",
                "line_descriptor",
                "optflow",
                "phase_unwrapping",
                "plot",
                "reg",
                "rgbd",
                "saliency",
                "shape",
                "stereo",
                "structured_light",
                "superres",
                "surface_matching",
                "tracking",
                "videostab",
                "xfeatures2d",
                "ximgproc",
                "xobjdetect",
                "xphoto",
                "sfm"] + opencv_libs

            if not self.options.freetype or not self.options.harfbuzz:
                opencv_libs.remove("freetype")
            if not self.options.eigen or not self.options.glog or not self.options.gflags:
                opencv_libs.remove("sfm")

        if self.options.cuda:
            opencv_libs = ["cudaarithm",
                            "cudabgsegm",
                            "cudacodec",
                            "cudafeatures2d",
                            "cudafilters",
                            "cudaimgproc",
                            "cudalegacy",
                            "cudaobjdetect",
                            "cudaoptflow",
                            "cudastereo",
                            "cudawarping",
                            "cudev"
                            ] + opencv_libs

        suffix = 'd' if self.settings.build_type == 'Debug' and self.settings.compiler == 'Visual Studio' else ''
        version = self.version.replace(
            ".", "") if self.settings.os == "Windows" else ""
        for lib in opencv_libs:
            self.cpp_info.libs.append("opencv_%s%s%s" % (lib, version, suffix))

        if self.options.cuda:
            self.cpp_info.libs.extend(["nvrtc", "cudart", "cuda"])

        if self.settings.os == "Linux":
            self.cpp_info.libs.extend([
                "pthread",
                "m",
                "dl"])
            if self.options.gtk == 2:
                self.add_libraries_from_pc('gtk+-2.0')
            elif self.options.gtk == 3:
                self.add_libraries_from_pc('gtk+-3.0')
        elif self.settings.os == 'Macos':
            for framework in ['OpenCL',
                              'Accelerate',
                              'CoreMedia',
                              'CoreVideo',
                              'CoreGraphics',
                              'AVFoundation',
                              'QuartzCore',
                              'Cocoa']:
                self.cpp_info.exelinkflags.append('-framework %s' % framework)
            self.cpp_info.sharedlinkflags = self.cpp_info.exelinkflags
        elif self.settings.os == 'Windows':
            self.cpp_info.libs.append('Vfw32')
        if self.settings.os == 'Android' and not self.options.shared:
            self.cpp_info.includedirs.append(
                os.path.join('sdk', 'native', 'jni', 'include'))
            self.cpp_info.libdirs.append(
                os.path.join('sdk', 'native', 'staticlibs'))
        else:
            self.cpp_info.includedirs.append(
                os.path.join('include', 'opencv4'))
            self.cpp_info.libdirs.append(
                os.path.join('lib', 'opencv4', '3rdparty'))
            if not self.options.shared:
                self.cpp_info.libs.append('ade')
        if self.options.contrib and self.options.eigen and self.options.glog and self.options.gflags:
            self.cpp_info.libs.append('multiview')
