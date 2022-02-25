# Demo of API available within embedded browser within desktop client
This is an example of how to use the C2P API's provided by the desktop client within the built in browser.

Before running any of the scripts below please make sure to run `npm install` to install dev dependencies.

## To run locally 
- Run `npm start` command to start dev server.
- Add webpage on desktop client with url `http://localhost:1234`. Make sure to enable "Allow using Client API" on the advanced tab.

## To serve compiled on your own server
- If you don't want to run the build scripts below to add the test page on your own server the compiled version is available at `compiled_client_api_test_page.html`.

## To build (regular)
You would run this command if you wanted to build the project to either run on a webserver or to include in another project.

- Run `npm run build` command.
- Files will be output to the `dist` folder.

## To build (single file)
You would run this command if you would like to easily statically serve this test page.

- Run `npm run build:single` command.
- The `single_output.html` will be output to the `dist` folder.
