// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
import { LFService, LoggerFactoryOptions, LogGroupRule, LogLevel } from 'typescript-logging';

/*
 * Create options instance and specifies 2 LogGroupRules:
 * One for any logger with a name starting with model, to log on debug.
 * The second one for anything else to log on info.
 */
const options = new LoggerFactoryOptions()
        .addLogGroupRule(new LogGroupRule(new RegExp('.+'), LogLevel.Info));

// Creates a named loggerfactory and pass in the options and export the factory.
export const factory = LFService.createNamedLoggerFactory('LoggerFactory', options);
