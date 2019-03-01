// NOTE: This is used with the OneSignalSDK.js shim
// Careful if adding imports, ES5 targets can't clean up functions never called.

import { OneSignalStub } from "./OneSignalStub";
import { ProcessOneSignalPushCalls } from "./ProcessOneSignalPushCalls";

export class OneSignalStubES5 extends OneSignalStub<OneSignalStubES5> {

  public constructor() {
    super(Object.getOwnPropertyNames(OneSignalStubES5.prototype));
  }

  // @Override
  public isPushNotificationsSupported(): boolean {
    return false;
  }

  // @Override
  public isPushNotificationsEnabled(): Promise<boolean> {
    return new Promise(resolve => { resolve(false); } );
  }

  // Implementation here so the passed in function is run and does not get dropped.
  // @Override
  public push(item: Function | object[]): void {
    ProcessOneSignalPushCalls.processItem(this, item);
  }

  // By default do nothing unless the function is listed above.
  // @Override
  protected stubFunction(_thisObj: OneSignalStubES5, _functionName: string, _args: any[]): any {}

  // Always reject promises as no logic will be run from this ES5 stub.
  // @Override
  protected stubPromiseFunction(_thisObj: OneSignalStubES5, _functionName: string, _args: any[]): Promise<any> {
    return new Promise((_resolve, reject) => { reject(); });
  }
}
