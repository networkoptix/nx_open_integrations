// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

export {};

declare global {
  interface InjectedObjects extends Record<any, any> {
    // TODO: Need to add types for all injected objects
  }

  interface Window extends InjectedObjects {}
}
