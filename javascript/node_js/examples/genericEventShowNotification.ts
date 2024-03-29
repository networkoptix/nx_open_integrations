// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
declare const Promise: any;
import {
    GenericEvent, Logger, Rule, RuntimeConfigManager, ShowPopup, System
} from '../src';
import * as path from 'path';

const logging = Logger.getLogger('On Generic Event Show Notification');

const runtimeConfigManager = new RuntimeConfigManager(path.resolve(__dirname, './nodeConfig.json'));

// Makes all of the rules on the target system.
const makeExampleRules = () => {
    const promiseRules: any[] = [];

    /*
     * Makes a rule that displays a notification when a generic event with 'node.js' as the source
     * is received.
     */
    const genericEvent: GenericEvent = new GenericEvent('Node.js');
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

    // Makes a rule that displays a notification whenever a generic event is received.
    const genericEvent2: GenericEvent = new GenericEvent();
    genericEvent2.config({});
    const catchAllEvents: Rule = new Rule('Catch All Events')
            .on(genericEvent2)
            .do(showNotification);
    promiseRules.push(server.saveRuleToSystem(catchAllEvents).then((rule: Rule | null) => {
        runtimeConfigManager.registerRule(rule);
        return rule;
    }));

    return Promise.all(promiseRules).then((values: any) => values);
};

const config = runtimeConfigManager.config;
const server: System = new System(config.systemUrl, config.username, config.password, config.rules);
server.login().then(() => {
    return server.getSystemRules().then(makeExampleRules);
});
