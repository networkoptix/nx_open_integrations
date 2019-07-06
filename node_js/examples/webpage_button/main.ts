// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import { GenericEvent,  Logger, NodeServer, RuntimeConfigManager, System } from 'nx-node-integration';
import { ButtonWebPage, ButtonWebPageManager, ButtonColors, BackgroundColors } from '.';
import { createNumPad } from '../../../internal_experiments/webpage_button/numPad';
import * as path from 'path';

const logging = Logger.getLogger('Web Page Button - Main');

const runtimeConfigManager = new RuntimeConfigManager(path.resolve(__dirname, './runtimeConfig.json'));
const config = runtimeConfigManager.config;

const server: System = new System(config.systemUrl, config.username, config.password,
                                  config.rules, config.webPages);
const nodeServer: NodeServer = new NodeServer(config.myIp, config.myPort);
const buttonWebPageManager = new ButtonWebPageManager(nodeServer, server, runtimeConfigManager);

/*
 * Creates multiple web page objects.
 * 1) A button that toggles between on, off and a tri-state.
 * 2) A button that toggles between 3 states. The text and color changes based on the current state.
 * 3) A button that toggles between a light bulb icon on and off.
 * 4) A counter with several other buttons that reset, increment and decrement the counter.
 * 5) A button that toggles between a yellow circle on and off.
 */
const addWebPages = () => {
    // The tri-state button.
    const genericEvent = new GenericEvent();
    const toggleButton = new ButtonWebPage('toggleButton', 'Toggle Button', '', 'Toggle',
        BackgroundColors.light10);
    toggleButton.configButton({color: ButtonColors.red, icon: 'fa-toggle-off', state: 'on'});
    // The callback is the state machine that can control the appearance of the button.
    toggleButton.setCallback(() => {
        switch (toggleButton.state) {
            case 'on':
                toggleButton.configButton({color: ButtonColors.green, icon: 'fa-toggle-on', state: 'tri'});
                break;
            case 'tri':
                toggleButton.configButton({color: ButtonColors.yellow, state: 'off'});
                break;
            case 'off':
            default:
                toggleButton.configButton({color: ButtonColors.red, icon: 'fa-toggle-off', state: 'on'});
        }
        // Configure a generic event to send to the server.
        genericEvent.config({caption: `${toggleButton.pageName} has changed to ${toggleButton.state}`});
        // Update the url to reflect the changes to the web page button.
        toggleButton.setUrl();
        // Send a generic event to the server.
        server.sendEvent({event: genericEvent});
        // Send the updated web page to the System.
        server.saveWebPageToSystem(toggleButton);
    });

    buttonWebPageManager.addButtonPage(toggleButton);

    // This button changes its text and color when pressed.
    const multiWordButton = new ButtonWebPage('manyNames', 'Name Change', '');
    multiWordButton.configButton({color: ButtonColors.yellow, state: 'tony', text: 'Where is Evgeny'});
    multiWordButton.setCallback(() => {
        switch (multiWordButton.state) {
            case 'tony':
                multiWordButton.configButton({color: ButtonColors.red, text: 'Where is Tony', state: 'alexander'});
                break;
            case 'alexander':
                multiWordButton.configButton({color: ButtonColors.brand, text: 'Where is Alexander', state: 'evgeny'});
                break;
            case 'evgeny':
            default:
                multiWordButton.configButton({color: ButtonColors.yellow, text: 'Where is Evgeny', state: 'tony'});
        }
        genericEvent.config({caption: `MultiWordButton text changed to ${multiWordButton.buttonText}`});
        multiWordButton.setUrl();
        server.sendEvent({event: genericEvent});
        server.saveWebPageToSystem(multiWordButton);
    });

    buttonWebPageManager.addButtonPage(multiWordButton);

    // Light bulb button.
    const lightSwitchButton = new ButtonWebPage('lightSwitch', 'Light Switch', '', 'Toggle light');
    lightSwitchButton.configButton({icon: 'fa-lightbulb-o', color: ButtonColors.dark, state: 'on'});
    lightSwitchButton.setCallback(() => {
        switch (lightSwitchButton.state) {
            case 'on':
                lightSwitchButton.configButton({color: ButtonColors.yellow, state: 'off'});
                break;
            case 'off':
            default:
                lightSwitchButton.configButton({color: ButtonColors.dark, state: 'on'});
        }
        genericEvent.config({caption: `Light's next state is ${lightSwitchButton.state}`});
        lightSwitchButton.setUrl();
        server.sendEvent({event: genericEvent});
        server.saveWebPageToSystem(lightSwitchButton);
    });

    buttonWebPageManager.addButtonPage(lightSwitchButton);

    // Counter button that increments when pressed.
    const counterButton = new ButtonWebPage('counterButton', 'Counter Button', '');
    counterButton.configButton({
        backgroundColor: BackgroundColors.light1,
        color: ButtonColors.brand,
        state: '1',
        text: 'People (per minute): 0'
    });
    counterButton.setCallback(() => {
        logging.info(`Counter button: ${counterButton.state}`);
        const state = parseInt(counterButton.state);
        counterButton.configButton({
            backgroundColor: BackgroundColors[state],
            color: ButtonColors[state],
            state: ((state + 1) % 6).toString(),
            text: `People (per minute): ${state}`
        });

        genericEvent.config({caption: `${counterButton.pageName} is now ${counterButton.state}`});
        server.sendEvent({event: genericEvent});
        counterButton.setUrl();
        server.saveWebPageToSystem(counterButton);
    });
    buttonWebPageManager.addButtonPage(counterButton);

    // Circular yellow button that toggles on and off.
    const yellowButton = new ButtonWebPage(
        'trafficYellow',
        'Traffic Yellow light',
        '',
        'Yellow light',
        ButtonColors.yellow,
        'fa-circle-o');
    yellowButton.configButton({state: 'off'});
    yellowButton.setCallback(() => {
        switch (yellowButton.state) {
            case 'on':
                yellowButton.configButton({icon: 'fa-circle', state: 'off'});
                break;
            case 'off':
            default:
                yellowButton.configButton({icon: 'fa-circle-o', state: 'on'});
        }
        yellowButton.setUrl();
        server.saveWebPageToSystem(yellowButton);
    });
    buttonWebPageManager.addButtonPage(yellowButton);

    createNumPad(buttonWebPageManager, server);
};

server.login().then(() => {
    return server.getSystemRules();
}).then(() => {
    return server.getSystemPages();
}).then(addWebPages);