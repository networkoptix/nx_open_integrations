// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import config from '../config';
import { NodeServer, BaseWebPage, Logger, System, RuntimeConfigManager, Rule,
    SoftTrigger, TriggerHttpCallback } from 'nx-node-integration';
import { ButtonWebPage } from './buttonWebPage';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';

const logging = Logger.getLogger('Button Web Page Manager');

/**
 * @class
 */
export class ButtonWebPageManager {
    public buttonPages: any;
    private nodeServer: NodeServer;
    private buttonTemplate: string;
    private mediaServer: System;
    private runtimeConfigManager: RuntimeConfigManager;

    /**
     * Creates express routes that web pages need to function.
     * @param nodeServer Processes requests, renders web page buttons, and executes callbacks.
     * @param mediaServer Saves web pages to the Server.
     * @param runtimeConfigManager Helps manage creating and updating resources between the integration code
     *    and the Server
     * @constructor
     */
    constructor(nodeServer: NodeServer, mediaServer: System, runtimeConfigManager: RuntimeConfigManager) {
        this.nodeServer = nodeServer;
        this.mediaServer = mediaServer;
        this.runtimeConfigManager = runtimeConfigManager;
        this.buttonPages = {};
        this.buttonTemplate = fs.readFileSync(path.resolve(__dirname, '../mustacheTemplates/button.mustache.html')).toString();


        this.nodeServer.addExpressHandler(`/${config.defaultButtonPageRoute}/:buttonId`, (req: express.Request, res: express.Response) => {
            logging.info(`${JSON.stringify(req.params)}`);
            if (!(req.params.buttonId in this.buttonPages)) {
                return res.sendStatus(500);
            }

            const buttonPage: ButtonWebPage = this.buttonPages[req.params.buttonId];
            if (req.query.next === '1' && buttonPage.callback) {
                buttonPage.callback();
            }

            return res.send(buttonPage.renderButton());
        });


        this.nodeServer.addExpressHandler('/static/font-awesome', express.static('node_modules/font-awesome'));
        this.nodeServer.addExpressHandler('/static', express.static('mustacheTemplates'));

    }

    /**
     * @param buttonPage The web page button that will be saved to the Server.
     */
    public addButtonPage(buttonPage: ButtonWebPage) {
        buttonPage.setRoute(this.nodeServer.address, config.defaultButtonPageRoute);
        this.buttonPages[buttonPage.id] = buttonPage;

        this.mediaServer.saveWebPageToSystem(buttonPage).then((id) => {
            buttonPage.setPageId(id);
            buttonPage.setMustacheTemplate(this.buttonTemplate);
            this.runtimeConfigManager.registerSystemObject('webPages', id, buttonPage.id);
        });
    }

    /**
     * Creates a soft trigger that has the same function as the web page button.
     * @param button A ButtonWebPage object. This is used to create the soft trigger.
     * @param icon What the soft trigger should look like.
     * @param nodeServer The node server that will process the soft trigger being pressed and fire
     *    its callback.
     * @param server The target Server where the rule will be created.
     */
    public createSoftTriggerForButton = (button: ButtonWebPage, icon: string, nodeServer: NodeServer,
                                                 server: System) => {
        const rule: TriggerHttpCallback = new TriggerHttpCallback(nodeServer, button.id, button.buttonText, icon, button.callback);
        server.saveRuleToSystem(rule).then((rule: Rule | null) => {
            this.runtimeConfigManager.registerRule(rule);
            return rule;
        });
    }

    // TODO: move mustacheHandler here ?
}

