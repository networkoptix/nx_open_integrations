// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

import * as fs from 'fs';
import { factory } from '../logConfig';
import { Rule } from '../data';

const logging = factory.getLogger('Runtime Config Manager');

/**
 * The RuntimeConfigManager helps manage local file to preserve server connection settings and saved object to avoid dublicates
 * @class
 */
export class RuntimeConfigManager {

    /**
     * configuration object
     */
    public config: any;

    /**
     * Path to the config file.
     */
    private configPath: string;

    /**
     * If the user passes in a blank config file it will be generated for them. Then, they just
     * need to fill in the file with the required information.
     * @param {string} configPath The full path to the config file.
     * @constructor
     */
    constructor(configPath: string) {
        if (!configPath) {
            logging.error('RuntimeConfigManager requires configPath');
            throw Error('RuntimeConfigManager requires configPath');
        } else if (!fs.existsSync(configPath)) {
            fs.writeFileSync(configPath, JSON.stringify({
                systemUrl: 'Ip of your system',
                serverVersion: 'Version of the server. Ex 4.0',
                myIp: 'Ip of this machine',
                myPort: 'Port on this machine you want to expose for nodeServer and nodeHttpActions',
                username: 'Preferably an account with admin access',
                password: 'That account\'s password',
                rules: {},
                webPages: {}
            }));
            logging.error('Please fill in the config.json file with the necessary information.');
            throw Error('Please fill in the config.json file with the necessary information.');
        }
        this.configPath = configPath;
        logging.info(`RuntimeConfigManager initializing with ${configPath}`);
        this.reloadConfigFile();
    }

    public reloadConfigFile() {
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    }

    public saveConfigFile() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, undefined, 4));
    }

    /**
     * Adds a setting to the config file.
     * @param {string} name
     * @param {string} value
     */
    public addGlobalSetting(name: string, value: string) {
        this.config[name] = value;
        this.saveConfigFile();
    }

    public registerSystemObject(objectGroup: string, codeId: string, systemObjectId: string|undefined) {
        if (!codeId) {
            logging.warn('Cannot register system object without codeId');
            return;
        }
        if (!systemObjectId) {
            logging.warn('Cannot register system object without systemObjectId');
            return;
        }
        this.saveObject(objectGroup, codeId, systemObjectId);
    }

    public saveObject(objectGroup: string, codeId: string, object: any) {
        if (!this.config[objectGroup]) {
            this.config[objectGroup] = {};
        }
        this.config[objectGroup][codeId] = object;
        this.saveConfigFile();
    }

    public registerRule(rule: Rule | null) {
        if (!rule) {
            logging.warn('Cannot register missing rule');
            return;
        }
        this.registerSystemObject('rules', rule.comment, rule.ruleId);
    }
}