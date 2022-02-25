#!/usr/bin/env bash

pushd ./dist

# extract content from body
sed -n '/<body>/,/<\/body>/p' ./index.html | sed -e '1s/.*<body>//' -e '$s/<\/body>.*//' > ./body.html

# rename js file
find . -name "index.*.js" -type f -exec sh -c 'x="{}"; mv "$x" "script.js"' \;

# rename css file
find . -name "index.*.css" -type f -exec sh -c 'x="{}"; mv "$x" "styles.css"' \;

rm index.html

popd
