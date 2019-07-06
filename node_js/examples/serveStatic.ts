// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import * as express from 'express';
import * as path from 'path';

import {
    Logger, GenericEvent, NodeServer, Rule, RuntimeConfigManager, ShowPopup, System, BaseWebPage
} from '../src';


const logging = Logger.getLogger('Express Static Serve');

const runtimeConfigManager = new RuntimeConfigManager(path.resolve(__dirname, './nodeConfig.json'));
const config = runtimeConfigManager.config;
const server: System = new System(config.systemUrl, config.username, config.password,
                                  config.rules, config.webPages);
const nodeServer: NodeServer = new NodeServer(config.myIp, config.myPort);

// Gets the rules from the target system and add a custom route to the express server.
const addCustomExpressRoute = () => {
    const webPageName = 'Test page';
    const staticRoute = 'static';
    const staticDirectory = 'examplePage';
    const url = `${config.myIp}:${config.myPort}/${staticRoute}`;
    const baseWebPage: BaseWebPage = new BaseWebPage('test', webPageName, url);
    nodeServer.addExpressHandler(`/${staticRoute}/`, express.static(`${__dirname}/${staticDirectory}`));
    server.saveWebPageToSystem(baseWebPage).then((res: any) => {
        logging.info(`${res}`);
        runtimeConfigManager.saveObject('webPages', res, baseWebPage.id);
    }, (error: any) => {
        logging.error('Unable to save web page to server');
        logging.error(`${error}`);
    });
};

const makeRule = () => {
    const promiseRules: any[] = [];
    /*
     * Makes a rule that displays a notification when a generic event with 'node.js' as the source
     * is received.
     */
    const genericEvent: GenericEvent = new GenericEvent();
    const showNotification: ShowPopup = new ShowPopup();
    const catchSpecificEvent = new Rule('Generic Event Popup', false)
            .on(genericEvent)
            .do(showNotification);
    // After this rule is made, test it by triggering the event manually.
    promiseRules.push(server.saveRuleToSystem(catchSpecificEvent)
            .then((rule: Rule | null) => {
                server.sendEvent({ event: genericEvent });
                runtimeConfigManager.registerRule(rule);
                return rule;
            })
    );

    nodeServer.addExpressHandler('/testpage', (req: express.Request, res: express.Response) => {
        genericEvent.config({source: 'node.js', caption: 'Test button', description: 'testing completed'});
        server.sendEvent({event: genericEvent});
        return res.send('ok');
    });
};

server.login().then(() => {
    return server.getSystemRules();
}).then(() => {
    return server.getSystemPages();
}).then(addCustomExpressRoute).then(makeRule);