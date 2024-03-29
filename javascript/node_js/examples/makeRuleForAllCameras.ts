// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import { Logger, NodeHttpAction, NodeServer, Rule, RuntimeConfigManager, SoftTrigger, System } from '../src';

import * as express from 'express';
import * as path from 'path';

const runtimeConfigManager = new RuntimeConfigManager(path.resolve(__dirname, './nodeConfig.json'));
const logging = Logger.getLogger('Make Rule For All Cameras in the System');

// Makes a rule for each camera currently on the system.
const makeExampleRules = (cameras: any) => {
    cameras = cameras.map((camera: any) => ({ id: camera.id, name: camera.name }));
    const customRoute = 'shark?state=open&cameraName=';

    for (const camera of cameras) {
        const softTrigger: SoftTrigger = new SoftTrigger(`Open - ${camera.name}`);
        const httpAction: NodeHttpAction = new NodeHttpAction(nodeServer);
        httpAction.configCustomHandler(`${customRoute}${camera.name}`,
                (query: any) => {
                    logging.info(`${query.cameraName} - was just ${query.state}`);
                });
        // Makes a rule that sends an http action to the express server when a soft trigger is pushed.
        const cameraRule = new Rule(`Open - ${camera.name}`)
                .on(softTrigger)
                .do(httpAction);
        cameraRule.config({ cameraIds: [camera.id] });
        server.saveRuleToSystem(cameraRule).then((rule: Rule) => {
            runtimeConfigManager.registerRule(rule);
        });
    }
};

// Adds a new route to the express server, and gets all of the cameras in the system.
const getCameras = () => {
    nodeServer.addExpressHandler('/shark',
            (req: express.Request, res: express.Response) => {
                logging.info(JSON.stringify(req.query));
                const key = `${req.query.state} - ${req.query.cameraName}`;
                if (key in nodeServer.httpActionCallbacks) {
                    nodeServer.httpActionCallbacks[key](req.query);
                    return res.send('Ok');
                }
                return res.send('Error: Query parameters do not have a callback function.');
            });
    return server.getCameras();
};

const config = runtimeConfigManager.config;
const server: System = new System(config.systemUrl, config.username, config.password, config.rules);
const nodeServer: NodeServer = new NodeServer(config.myIp, config.myPort);
server.login().then(() => {
    return server.getSystemRules();
}).then(getCameras).then(makeExampleRules);
