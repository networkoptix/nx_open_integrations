#!/bin/bash

BASEDIR=/opt/$1/mediaserver
sudo /opt/$1/mediaserver/bin/root-tool-bin&
$BASEDIR/bin/mediaserver-bin  -e
