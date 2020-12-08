#!/bin/bash
CUSTOMIZATION=$1
BASEDIR=/opt/$CUSTOMIZATION/mediaserver
sudo /opt/$CUSTOMIZATION/mediaserver/bin/root-tool-bin&
$BASEDIR/bin/mediaserver-bin  -e