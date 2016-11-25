import { DEV_HOST, DEV_FRAME_HOST, PROD_HOST, API_URL, STAGING_FRAME_HOST, DEV_PREFIX, STAGING_PREFIX } from './vars';
import Environment from './Environment';
import OneSignalApi from './OneSignalApi';
import IndexedDb from './IndexedDb';
import * as log from 'loglevel';
import Event from "./Event";
import Bell from "./bell/Bell";
import * as Cookie from 'js-cookie';
import Database from './Database';
import * as Browser from 'bowser';
import {
  isPushNotificationsSupported, logMethodCall, isValidEmail, awaitOneSignalInitAndSupported, getConsoleStyle,
  contains, unsubscribeFromPush, decodeHtmlEntities, getUrlQueryParam, executeAndTimeoutPromiseAfter,
  wipeLocalIndexedDb, prepareEmailForHashing, executeCallback, isValidUrl, once, md5, sha1
} from './utils';
import * as objectAssign from 'object-assign';
import * as EventEmitter from 'wolfy87-eventemitter';
import * as heir from 'heir';
import * as swivel from 'swivel';
import Postmam from './Postmam';
import EventHelper from './helpers/EventHelper';
import MainHelper from './helpers/MainHelper';
import Popover from './popover/Popover';
import {Uuid} from "./models/Uuid";
import {InvalidArgumentError, InvalidArgumentReason} from "./errors/InvalidArgumentError";
import LimitStore from "./LimitStore";
import {InvalidStateError, InvalidStateReason} from "./errors/InvalidStateError";
import InitHelper from "./helpers/InitHelper";
import ServiceWorkerHelper from "./helpers/ServiceWorkerHelper";
import SubscriptionHelper from "./helpers/SubscriptionHelper";
import HttpHelper from "./helpers/HttpHelper";



export default class OneSignal {

  /**
   * Pass in the full URL of the default page you want to open when a notification is clicked.
   * @PublicApi
   */
  static async setDefaultNotificationUrl(url: URL) {
    if (!isValidUrl(url))
      throw new InvalidArgumentError('url', InvalidArgumentReason.Malformed);
    await awaitOneSignalInitAndSupported();
    logMethodCall('setDefaultNotificationUrl', url);
    const appState = await Database.getAppState();
    appState.defaultNotificationUrl = url;
    await Database.setAppState(appState);
  }

  /**
   * Sets the default title to display on notifications. Will default to the page's document.title if you don't call this.
   * @remarks Either DB value defaultTitle or pageTitle is used when showing a notification title.
   * @PublicApi
   */
  static async setDefaultTitle(title: string) {
    await awaitOneSignalInitAndSupported();
    logMethodCall('setDefaultTitle', title);
    const appState = await Database.getAppState();
    appState.defaultNotificationTitle = title;
    await Database.setAppState(appState);
  }

  /**
   * Hashes the provided email and uploads to OneSignal.
   * @remarks The email is voluntarily provided.
   * @PublicApi
   */
  static async syncHashedEmail(email) {
    if (!email)
      throw new InvalidArgumentError('email', InvalidArgumentReason.Empty);
    let sanitizedEmail = prepareEmailForHashing(email);
    if (!isValidEmail(sanitizedEmail))
      throw new InvalidArgumentError('email', InvalidArgumentReason.Malformed);
    await awaitOneSignalInitAndSupported();
    logMethodCall('syncHashedEmail', email);
    const subscription = await Database.getSubscription();
    if (!subscription.deviceId)
      throw new InvalidStateError(InvalidStateReason.NotSubscribed);
    const result = await OneSignalApi.updatePlayer(subscription.deviceId, {
      em_m: md5(sanitizedEmail),
      em_s: sha1(sanitizedEmail)
    });
    if (result && result.success) {
      return true;
    } else {
      return result;
    }
  }

  /**
   * Returns true if the current browser supports web push.
   * @PublicApi
   */
  static isPushNotificationsSupported() {
    logMethodCall('isPushNotificationsSupported');
    return isPushNotificationsSupported();
  }

  /**
   * Initializes the SDK, called by the developer.
   * @PublicApi
   */
  static init(options) {
    logMethodCall('init', options);

    ServiceWorkerHelper.applyServiceWorkerEnvPrefixes();

    if (Environment.isBrowser() && window.localStorage && window.localStorage["onesignal.debugger.init"])
      debugger;

    if (OneSignal._initCalled) {
      log.error(`OneSignal: Please don't call init() more than once. Any extra calls to init() are ignored. The following parameters were not processed: %c${JSON.stringify(Object.keys(options))}`, getConsoleStyle('code'));
      return 'return';
    }
    OneSignal._initCalled = true;

    OneSignal.config = objectAssign({
      path: '/'
    }, options);

    if (!isPushNotificationsSupported()) {
      console.warn('OneSignal: Push notifications are not supported.');
      return;
    }

    if (Browser.safari && !OneSignal.config.safari_web_id) {
      log.warn("OneSignal: Required parameter %csafari_web_id", getConsoleStyle('code'), 'was not passed to OneSignal.init(), skipping SDK initialization.');
      return;
    }

    function __init() {
      if (OneSignal.__initAlreadyCalled) {
        // Call from window.addEventListener('DOMContentLoaded', () => {
        // Call from if (document.readyState === 'complete' || document.readyState === 'interactive')
        return;
      } else {
        OneSignal.__initAlreadyCalled = true;
      }
      MainHelper.fixWordpressManifestIfMisplaced();

      if (SubscriptionHelper.isUsingSubscriptionWorkaround()) {
        if (OneSignal.config.subdomainName) {
          OneSignal.config.subdomainName = MainHelper.autoCorrectSubdomain(OneSignal.config.subdomainName);
        } else {
          log.error('OneSignal: Your JavaScript initialization code is missing a required parameter %csubdomainName',
            getConsoleStyle('code'),
            '. HTTP sites require this parameter to initialize correctly. Please see steps 1.4 and 2 at ' +
            'https://documentation.onesignal.com/docs/web-push-sdk-setup-http)');
          return;
        }

        if (Environment.isDev()) {
          OneSignal.iframeUrl = `${DEV_FRAME_HOST}/webPushIframe`;
          OneSignal.popupUrl = `${DEV_FRAME_HOST}/subscribe`;
        }
        else {
          OneSignal.iframeUrl = `https://${OneSignal.config.subdomainName}.onesignal.com/webPushIframe`;
          OneSignal.popupUrl = `https://${OneSignal.config.subdomainName}.onesignal.com/subscribe`;
        }
      } else {
        if (Environment.isDev()) {
          OneSignal.modalUrl = `${DEV_FRAME_HOST}/webPushModal`;
        } else if (Environment.isStaging()) {
          OneSignal.modalUrl = `${STAGING_FRAME_HOST}/webPushModal`;
        } else {
          OneSignal.modalUrl = `https://onesignal.com/webPushModal`;
        }
      }


      let subdomainPromise = Promise.resolve();
      if (SubscriptionHelper.isUsingSubscriptionWorkaround()) {
        subdomainPromise = HttpHelper.loadSubdomainIFrame()
                                    .then(() => log.info('Subdomain iFrame loaded'))
      }

      OneSignal.on(Database.EVENTS.REBUILT, EventHelper.onDatabaseRebuilt);
      OneSignal.on(OneSignal.EVENTS.NATIVE_PROMPT_PERMISSIONCHANGED, EventHelper.onNotificationPermissionChange);
      OneSignal.on(OneSignal.EVENTS.SUBSCRIPTION_CHANGED, EventHelper._onSubscriptionChanged);
      OneSignal.on(Database.EVENTS.SET, EventHelper._onDbValueSet);
      OneSignal.on(OneSignal.EVENTS.INTERNAL_SUBSCRIPTIONSET, EventHelper._onInternalSubscriptionSet);
      OneSignal.on(OneSignal.EVENTS.SDK_INITIALIZED, InitHelper.onSdkInitialized);
      subdomainPromise.then(() => {
        window.addEventListener('focus', (event) => {
          // Checks if permission changed everytime a user focuses on the page, since a user has to click out of and back on the page to check permissions
          MainHelper.checkAndTriggerNotificationPermissionChanged();
        });

        // If Safari - add 'fetch' pollyfill if it isn't already added.
        if (Browser.safari && typeof window.fetch == "undefined") {
          var s = document.createElement('script');
          s.setAttribute('src', "https://cdnjs.cloudflare.com/ajax/libs/fetch/0.9.0/fetch.js");
          document.head.appendChild(s);
        }

        if (Environment.isCustomSubdomain()) {
          Event.trigger(OneSignal.EVENTS.SDK_INITIALIZED);
          return;
        }

        InitHelper.initSaveState()
                 .then(() => InitHelper.saveInitOptions())
                 .then(() => InitHelper.internalInit());
      });
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      __init();
    }
    else {
      log.debug('OneSignal: Waiting for DOMContentLoaded or readyStateChange event before continuing' +
        ' initialization...');
      window.addEventListener('DOMContentLoaded', () => {
        __init();
      });
      document.onreadystatechange = () => {
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
          __init();
        }
      };
    }
  }

  /**
   * Shows a sliding modal prompt on the page for users to trigger the HTTP popup window to subscribe.
   * @PublicApi
   */
  static showHttpPrompt(options?) {
    return awaitOneSignalInitAndSupported()
      .then(() => {
        /*
         Only show the HTTP popover if:
         - Notifications aren't already enabled
         - The user isn't manually opted out (if the user was manually opted out, we don't want to prompt the user)
         */
        if (OneSignal.__isPopoverShowing) {
          log.debug('OneSignal: Not showing popover because it is currently being shown.');
          return 'popover-already-shown';
        }
        return Promise.all([
          OneSignal.getNotificationPermission(),
          OneSignal.isPushNotificationsEnabled(),
          OneSignal.getSubscription(),
          Database.get('Options', 'popoverDoNotPrompt')
        ])
                      .then(([permission, isEnabled, notOptedOut, doNotPrompt]) => {
                        if (doNotPrompt === true && (!options || options.force == false)) {
                          log.debug('OneSignal: Not showing popover because the user previously clicked "No Thanks".');
                          return 'popover-previously-dismissed';
                        }
                        if (permission === 'denied') {
                          log.debug('OneSignal: Not showing popover because notification permissions are blocked.');
                          return 'notification-permission-blocked';
                        }
                        if (isEnabled) {
                          log.debug('OneSignal: Not showing popover because the current user is already subscribed.');
                          return 'user-already-subscribed';
                        }
                        if (!notOptedOut) {
                          log.debug('OneSignal: Not showing popover because the user was manually opted out.');
                          return 'user-intentionally-unsubscribed';
                        }
                        if (MainHelper.isUsingHttpPermissionRequest() && permission !== 'granted') {
                          log.debug('OneSignal: Not showing popover because the HTTP permission request is being shown instead.');
                          return 'using-http-permission-request';
                        }
                        MainHelper.markHttpPopoverShown();
                        OneSignal.popover = new Popover(OneSignal.config.promptOptions);
                        OneSignal.popover.create();
                        log.debug('Showing the HTTP popover.');
                        if (OneSignal.notifyButton && OneSignal.notifyButton.launcher.state !== 'hidden') {
                          OneSignal.notifyButton.launcher.waitUntilShown()
                                   .then(() => {
                                     OneSignal.notifyButton.launcher.hide();
                                   });
                        }
                        OneSignal.once(Popover.EVENTS.SHOWN, () => {
                          OneSignal.__isPopoverShowing = true;
                        });
                        OneSignal.once(Popover.EVENTS.CLOSED, () => {
                          OneSignal.__isPopoverShowing = false;
                          if (OneSignal.notifyButton) {
                            OneSignal.notifyButton.launcher.show();
                          }
                        });
                        OneSignal.once(Popover.EVENTS.ALLOW_CLICK, () => {
                          OneSignal.popover.close();
                          OneSignal.registerForPushNotifications({autoAccept: true});
                        });
                        OneSignal.once(Popover.EVENTS.CANCEL_CLICK, () => {
                          log.debug("Setting flag to not show the popover to the user again.");
                          Database.put('Options', {key: 'popoverDoNotPrompt', value: true});
                        });
                      });
      });
  }

  /**
   * Prompts the user to subscribe.
   * @PublicApi
   */
  static registerForPushNotifications(options?) {
    return awaitOneSignalInitAndSupported()
      .then(() => {
        if (SubscriptionHelper.isUsingSubscriptionWorkaround()) {
          HttpHelper.loadPopup(options);
        } else {
          if (!options)
            options = {};
          options.fromRegisterFor = true;
          InitHelper.sessionInit(options);
        }
      });
  }
  /**
   * Prompts the user to subscribe using the remote local notification workaround for HTTP sites.
   * @PublicApi
   */
  static showHttpPermissionRequest() {
    log.debug('Called showHttpPermissionRequest().');

    return awaitOneSignalInitAndSupported()
      .then(() => new Promise((resolve, reject) => {
        // Safari's push notifications are one-click Allow and shouldn't support this workaround
        if (Browser.safari) {
          return;
        }

        if (SubscriptionHelper.isUsingSubscriptionWorkaround()) {
          OneSignal.iframePostmam.message(OneSignal.POSTMAM_COMMANDS.SHOW_HTTP_PERMISSION_REQUEST, null, reply => {
            let {status, result} = reply.data;
            if (status === 'resolve') {
              resolve(result);
            } else {
              reject(result);
            }
          });
        } else {
          if (!MainHelper.isUsingHttpPermissionRequest()) {
            log.debug('Not showing HTTP permission request because its not enabled. Check init option httpPermissionRequest.');
            Event.trigger(OneSignal.EVENTS.TEST_INIT_OPTION_DISABLED);
            return;
          }

          log.debug(`(${Environment.getEnv()}) Showing HTTP permission request.`);
          if (window.Notification.permission === "default") {
            window.Notification.requestPermission(permission => {
              resolve(permission);
              log.debug('HTTP Permission Request Result:', permission);
              if (permission === 'default') {
                OneSignal.iframePostmam.message(OneSignal.POSTMAM_COMMANDS.REMOTE_NOTIFICATION_PERMISSION_CHANGED, {
                  permission: permission,
                  forceUpdatePermission: true
                });
              }
            });
            Event.trigger(OneSignal.EVENTS.PERMISSION_PROMPT_DISPLAYED);
          } else {
            Event.trigger(OneSignal.EVENTS.TEST_WOULD_DISPLAY);
            const rejectReason = 'OneSignal: HTTP permission request not displayed because notification permission is already ' + window.Notification.permission + '.';
            log.debug(rejectReason);
            reject(rejectReason);
          }
        }
      }));
  }

  /**
   * Returns a promise that resolves to the browser's current notification permission as 'default', 'granted', or 'denied'.
   * @param callback A callback function that will be called when the browser's current notification permission has been obtained, with one of 'default', 'granted', or 'denied'.
   * @PublicApi
   */
  static getNotificationPermission(onComplete?) {
    return awaitOneSignalInitAndSupported()
      .then(() => {
        let safariWebId = null;
        if (OneSignal.config) {
          safariWebId = OneSignal.config.safari_web_id;
        }
        return MainHelper.getNotificationPermission(safariWebId);
      })
      .then(permission => {
        if (onComplete) {
          onComplete(permission);
        }
        return permission;
      });
  }

  /**
   * @PublicApi
   */
  static getTags(callback) {
    return awaitOneSignalInitAndSupported()
      .then(() => OneSignal.getUserId())
      .then(userId => {
        if (userId) {
          return OneSignalApi.get(`players/${userId}`, null, null);
        } else {
          return null;
        }
      })
      .then((response: any) => {
        let tags = (response ? response.tags : null);
        if (callback) {
          callback(tags);
        }
        return tags;
      });
  }

  /**
   * @PublicApi
   */
  static sendTag(key, value, callback?) {
    return awaitOneSignalInitAndSupported()
      .then(() => {
        let tag = {};
        tag[key] = value;
        return OneSignal.sendTags(tag, callback);
      });
  }

  /**
   * @PublicApi
   */
  static sendTags(tags, callback?) {
    return awaitOneSignalInitAndSupported()
      .then(() => {
        // Our backend considers false as removing a tag, so this allows false to be stored as a value
        if (tags) {
          Object.keys(tags).forEach(key => {
            if (tags[key] === false) {
              tags[key] = "false";
            }
          });
        }

        let willResolveInFuture = false;

        return new Promise((innerResolve, innerReject) => {
          Promise.all([
            MainHelper.getAppId(),
            OneSignal.getUserId()
          ])
                 .then(([appId, userId]) => {
                   if (userId) {
                     return OneSignalApi.put(`players/${userId}`, {
                       app_id: appId,
                       tags: tags
                     }, null)
                   }
                   else {
                     willResolveInFuture = true;
                     OneSignal.on(Database.EVENTS.SET, e => {
                       if (e && e.type === 'userId') {
                         OneSignal.sendTags(tags, callback).then(innerResolve);
                         return true;
                       }
                     });
                   }
                 })
                 .then(() => {
                   if (!willResolveInFuture) {
                     if (callback) {
                       callback(tags);
                     }
                     innerResolve(tags);
                   }
                 })
                 .catch(e => {
                   log.error('sendTags:', e);
                   innerReject(e);
                 });
        });
      })
  }

  /**
   * @PublicApi
   */
  static deleteTag(tag) {
    return awaitOneSignalInitAndSupported()
      .then(() => {
        if (typeof tag === 'string' || tag instanceof String) {
          return OneSignal.deleteTags([tag]);
        } else {
          return Promise.reject(new Error(`OneSignal: Invalid tag '${tag}' to delete. You must pass in a string.`));
        }
      });
  }

  /**
   * @PublicApi
   */
  static deleteTags(tags, callback?) {
    return awaitOneSignalInitAndSupported()
      .then(() => {
        if (tags instanceof Array && tags.length > 0) {
          var jsonPair = {};
          var length = tags.length;
          for (var i = 0; i < length; i++)
            jsonPair[tags[i]] = "";

          return OneSignal.sendTags(jsonPair);
        } else {
          throw new Error(`OneSignal: Invalid tags '${tags}' to delete. You must pass in array of strings with at least one tag string to be deleted.`);
        }
      })
      .then(emptySentTagsObj => {
        let emptySentTags = Object.keys(emptySentTagsObj);
        if (callback) {
          callback(emptySentTags);
        }
        return emptySentTags;
      });
  }

  /**
   * @PublicApi
   */
  static addListenerForNotificationOpened(callback?) {
    return awaitOneSignalInitAndSupported()
      .then(() => {
        OneSignal._notificationOpenedCallbacks.push(callback);
        EventHelper.fireSavedNotificationClickedCallbacks();
      });
  }
  /**
   * @PublicApi
   * @Deprecated
   */
  static getIdsAvailable(callback?) {
    if (!isPushNotificationsSupported()) {
      log.warn('OneSignal: Push notifications are not supported.');
      return;
    }

    console.info("OneSignal: getIdsAvailable() is deprecated. Please use getUserId() or getRegistrationId() instead.");

    if (callback === undefined)
      return;

    function __getIdsAvailable() {
      Promise.all([
        OneSignal.getUserId(),
        OneSignal.getRegistrationId()
      ]).then(results => {
        let [userId, registrationId] = results;

        if (callback) {
          callback({
            userId: userId,
            registrationId: registrationId
          })
        }
      });
    }

    OneSignal.isPushNotificationsEnabled(isEnabled => {
      if (!isEnabled) {
        OneSignal.on(OneSignal.EVENTS.SUBSCRIPTION_CHANGED, newSubscriptionState => {
          if (newSubscriptionState === true) {
            __getIdsAvailable();
          }
        })
      } else {
        return __getIdsAvailable();
      }
    });
  }

  /**
   * Returns a promise that resolves to true if all required conditions for push messaging are met; otherwise resolves to false.
   * @param callback A callback function that will be called when the current subscription status has been obtained.
   * @PublicApi
   */
  static isPushNotificationsEnabled(callback?) {
    return awaitOneSignalInitAndSupported()
      .then(() => Promise.all([
        OneSignal.getUserId(),
        OneSignal.getRegistrationId(),
        OneSignal.getNotificationPermission(),
        OneSignal.getSubscription(),
        ServiceWorkerHelper.isServiceWorkerActive()
      ]))
      .then(([userId, registrationId, notificationPermission, optIn, serviceWorkerActive]) => {
        let isPushEnabled = false;

        if ('serviceWorker' in navigator && !SubscriptionHelper.isUsingSubscriptionWorkaround() && !Environment.isIframe()) {
          isPushEnabled = userId &&
            registrationId &&
            notificationPermission === 'granted' &&
            optIn &&
            serviceWorkerActive;
        } else {
          isPushEnabled = userId &&
            registrationId &&
            notificationPermission === 'granted' &&
            optIn;
        }
        isPushEnabled = (isPushEnabled == true);

        if (callback) {
          callback(isPushEnabled);
        }
        return isPushEnabled;
      });
  }

  /**
   * @PublicApi
   */
  static setSubscription(newSubscription) {
    if (!isPushNotificationsSupported()) {
      log.warn('OneSignal: Push notifications are not supported.');
      return;
    }

    return new Promise((resolve, reject) => {
      // Get the current subscription and user ID; will correctly retrieve values from remote iFrame IndexedDB if necessary
      Promise.all([
        OneSignal.getSubscription(),
        OneSignal.getUserId()
      ]).then(results => {
        let [subscription, userId] = results;

        if (!userId) {
          log.warn(`Cannot set the user's subscription state to '${newSubscription}' because no user ID was stored.`);
          resolve(false);
          return;
        }

        if (subscription === newSubscription) {
          // The user wants to set the new subscription to the same value; don't change it
          resolve(false);
          return;
        }

        // All checks pass, actually set the subscription
        let dbOpPromise = null;
        if (SubscriptionHelper.isUsingSubscriptionWorkaround()) {
          dbOpPromise = new Promise((resolve, reject) => {
            OneSignal.iframePostmam.message(OneSignal.POSTMAM_COMMANDS.REMOTE_DATABASE_PUT, [{
              table: 'Options',
              keypath: {key: "subscription", value: newSubscription}
            }], reply => {
              if (reply.data === OneSignal.POSTMAM_COMMANDS.REMOTE_OPERATION_COMPLETE) {
                resolve();
              } else {
                reject('Tried to set remote db subscription value, but did not get complete response.');
              }
            });
          });
        } else {
          dbOpPromise = Database.put('Options', {key: "subscription", value: newSubscription});
        }

        // Forward the result to OneSignal
        dbOpPromise
          .then(() => MainHelper.getAppId())
          .then(appId => {
            return OneSignalApi.put('players/' + userId, {
              app_id: appId,
              notification_types: MainHelper.getNotificationTypeFromOptIn(newSubscription)
            }, null);
          })
          .then(() => {
            EventHelper.triggerInternalSubscriptionSet(newSubscription);
            resolve(true);
          });
      });
    });
  }

  /**
   * @PendingPublicApi
   */
  static isOptedOut(callback) {
    if (!isPushNotificationsSupported()) {
      log.warn('OneSignal: Push notifications are not supported.');
      return;
    }

    return OneSignal.getSubscription().then(manualSubscriptionStatus => {
      if (callback) {
        callback(!manualSubscriptionStatus);
      }
      return !manualSubscriptionStatus;
    });
  }

  /**
   * Returns a promise that resolves once the manual subscription override has been set.
   * @private
   * @returns {Promise}
   * @PendingPublicApi
   */
  static optOut(doOptOut, callback) {
    if (doOptOut !== false || doOptOut !== true) {
      throw new Error(`Invalid parameter '${doOptOut}' passed to OneSignal.optOut(). You must specify true or false.`);
    }
    return OneSignal.setSubscription(doOptOut).then(() => {
        if (callback) {
          callback();
        }
      }
    );
  }

  /**
   * Returns a promise that resolves to the stored OneSignal user ID if one is set; otherwise null.
   * @param callback A function accepting one parameter for the OneSignal user ID.
   * @PublicApi
   */
  static async getUserId(callback?: Action<Uuid>): Promise<Uuid> {
    logMethodCall('getUserId', callback);
    await awaitOneSignalInitAndSupported()
    const userId: Uuid = await Database.get<Uuid>('Ids', 'userId');
    executeCallback<Uuid>(callback, userId);
    return userId;
  }

  /**
   * Returns a promise that resolves to the stored OneSignal registration ID if one is set; otherwise null.
   * @param callback A function accepting one parameter for the OneSignal registration ID.
   * @returns {Promise.<T>}
   * @PublicApi
   */
  static getRegistrationId(callback?) {
    return awaitOneSignalInitAndSupported()
      .then(() => Database.get('Ids', 'registrationId'))
      .then(result => {
        if (callback) {
          callback(result)
        }
        return result;
      });
  }

  /**
   * Returns a promise that resolves to false if setSubscription(false) is "in effect". Otherwise returns true.
   * This means a return value of true does not mean the user is subscribed, only that the user did not call setSubcription(false).
   * @private
   * @returns {Promise}
   * @PublicApi (given to customers)
   */
  static getSubscription(callback?) {
    return awaitOneSignalInitAndSupported()
      .then(() => Database.get('Options', 'subscription'))
      .then(result => {
        if (result == null) {
          result = true;
        }
        if (callback) {
          callback(result)
        }
        return result;
      });
  }

  static __doNotShowWelcomeNotification: boolean;
  static VERSION = __VERSION__;
  static _VERSION = __VERSION__;
  static _API_URL = API_URL;
  static _notificationOpenedCallbacks = [];
  static _idsAvailable_callback = [];
  static _defaultLaunchURL = null;
  static config = null;
  static _thisIsThePopup = false;
  static __isPopoverShowing = false;
  static _sessionInitAlreadyRunning = false;
  static _isNotificationEnabledCallback = [];
  static _subscriptionSet = true;
  static iframeUrl = null;
  static popupUrl = null;
  static modalUrl = null;
  static _sessionIframeAdded = false;
  static _windowWidth = 650;
  static _windowHeight = 568;
  static _isNewVisitor = false;
  static _channel = null;
  static cookie = Cookie;
  static initialized = false;
  static notifyButton = null;
  static store = LimitStore;
  static environment = Environment;
  static database = Database;
  static event = Event;
  static browser = Browser;
  static popover = null;
  static log = log;
  static swivel = swivel;
  static api = OneSignalApi;
  static indexedDb = IndexedDb;
  static iframePostmam = null;
  static popupPostmam = null;
  static helpers = MainHelper;
  static objectAssign = objectAssign;
  static sendSelfNotification = MainHelper.sendSelfNotification;
  static SERVICE_WORKER_UPDATER_PATH = 'OneSignalSDKUpdaterWorker.js';
  static SERVICE_WORKER_PATH = 'OneSignalSDKWorker.js';
  static SERVICE_WORKER_PARAM = {scope: '/'};
  static _LOGGING = false;
  static LOGGING = false;
  static _usingNativePermissionHook = false;
  static _initCalled = false;
  static __initAlreadyCalled = false;
  static _thisIsTheModal: boolean;
  static modalPostmam: any;
  static httpPermissionRequestPostModal: any;


  /**
   * Used by Rails-side HTTP popup. Must keep the same name.
   * @InternalApi
   */
  static _initHttp = HttpHelper.initHttp;

  /**
   * Used by Rails-side HTTP popup. Must keep the same name.
   * @InternalApi
   */
  static _initPopup = HttpHelper.initPopup;

  /**
   * Used to load OneSignal asynchronously from a webpage.
   * @InternalApi
   */
  static push = InitHelper.push;

  static POSTMAM_COMMANDS = {
    CONNECTED: 'connect',
    REMOTE_NOTIFICATION_PERMISSION: 'postmam.remoteNotificationPermission',
    REMOTE_DATABASE_GET: 'postmam.remoteDatabaseGet',
    REMOTE_DATABASE_PUT: 'postmam.remoteDatabasePut',
    REMOTE_DATABASE_REMOVE: 'postmam.remoteDatabaseRemove',
    REMOTE_OPERATION_COMPLETE: 'postman.operationComplete',
    REMOTE_RETRIGGER_EVENT: 'postmam.remoteRetriggerEvent',
    MODAL_LOADED: 'postmam.modalPrompt.loaded',
    MODAL_PROMPT_ACCEPTED: 'postmam.modalPrompt.accepted',
    MODAL_PROMPT_REJECTED: 'postmam.modalPrompt.canceled',
    POPUP_LOADED: 'postmam.popup.loaded',
    POPUP_ACCEPTED: 'postmam.popup.accepted',
    POPUP_REJECTED: 'postmam.popup.canceled',
    POPUP_CLOSING: 'postman.popup.closing',
    REMOTE_NOTIFICATION_PERMISSION_CHANGED: 'postmam.remoteNotificationPermissionChanged',
    NOTIFICATION_OPENED: 'postmam.notificationOpened',
    IFRAME_POPUP_INITIALIZE: 'postmam.iframePopupInitialize',
    UNSUBSCRIBE_FROM_PUSH: 'postmam.unsubscribeFromPush',
    BEGIN_BROWSING_SESSION: 'postmam.beginBrowsingSession',
    REQUEST_HOST_URL: 'postmam.requestHostUrl',
    SHOW_HTTP_PERMISSION_REQUEST: 'postmam.showHttpPermissionRequest',
    WINDOW_TIMEOUT: 'postmam.windowTimeout',
    FINISH_REMOTE_REGISTRATION: 'postmam.finishRemoteRegistration',
    FINISH_REMOTE_REGISTRATION_IN_PROGRESS: 'postmam.finishRemoteRegistrationInProgress'
  }

  static EVENTS = {
    /**
     * Occurs when the user clicks the "Continue" or "No Thanks" button on the HTTP popup or HTTPS modal prompt.
     * For HTTP sites (and HTTPS sites using the modal prompt), this event is fired before the native permission
     * prompt is shown. This event is mostly used for HTTP sites.
     */
    CUSTOM_PROMPT_CLICKED: 'customPromptClick',
    /**
     * Occurs when the user clicks "Allow" or "Block" on the native permission prompt on Chrome, Firefox, or Safari.
     * This event is used for both HTTP and HTTPS sites and occurs after the user actually grants notification
     * permissions for the site. Occurs before the user is actually subscribed to push notifications.
     */
    NATIVE_PROMPT_PERMISSIONCHANGED: 'notificationPermissionChange',
    /**
     * Occurs after the user is officially subscribed to push notifications. The service worker is fully registered
     * and activated and the user is eligible to receive push notifications at any point after this.
     */
    SUBSCRIPTION_CHANGED: 'subscriptionChange',
    /**
     * Occurs after a POST call to OneSignal's server to send the welcome notification has completed. The actual
     * notification arrives shortly after.
     */
    WELCOME_NOTIFICATION_SENT: 'sendWelcomeNotification',
    /**
     * Occurs when a notification is displayed.
     */
    NOTIFICATION_DISPLAYED: 'notificationDisplay',
    /**
     * Occurs when a notification is dismissed by the user either clicking 'X' or clearing all notifications
     * (available in Android). This event is NOT called if the user clicks the notification's body or any of the
     * action buttons.
     */
    NOTIFICATION_DISMISSED: 'notificationDismiss',
    /**
     * An internal legacy event that should be deprecated.
     */
    INTERNAL_SUBSCRIPTIONSET: 'subscriptionSet',
    /**
     * Occurs after the document ready event fires and, for HTTP sites, the iFrame to subdomain.onesignal.com has
     * loaded.
     * Before this event, IndexedDB access is not possible for HTTP sites.
     */
    SDK_INITIALIZED: 'initialize',
    /**
     * Occurs after the user subscribes to push notifications and a new user entry is created on OneSignal's server,
     * and also occurs when the user begins a new site session and the last_session and last_active is updated on
     * OneSignal's server.
     */
    REGISTERED: 'register',
    /**
     * Occurs as the HTTP popup is closing.
     */
    POPUP_CLOSING: 'popupClose',
    /**
     * Occurs when the native permission prompt is displayed.
     */
    PERMISSION_PROMPT_DISPLAYED: 'permissionPromptDisplay',
    /**
     * For internal testing only. Used for all sorts of things.
     */
    TEST_INIT_OPTION_DISABLED: 'testInitOptionDisabled',
    TEST_WOULD_DISPLAY: 'testWouldDisplay',
    POPUP_WINDOW_TIMEOUT: 'popupWindowTimeout',
  };

  static NOTIFICATION_TYPES = {
    SUBSCRIBED: 1,
    UNSUBSCRIBED: -2
  };

  /** To appease TypeScript, EventEmitter later overrides this */
  static on(...args) {}
  static off(...args) {}
  static once(...args) {}
}

Object.defineProperty(OneSignal, 'LOGGING', {
  get: function() {
    return OneSignal._LOGGING;
  },
  set: function(logLevel) {
    if (logLevel) {
      log.setDefaultLevel((<any>log).levels.TRACE);
      OneSignal._LOGGING = true;
    }
    else {
      log.setDefaultLevel((<any>log).levels.ERROR);
      OneSignal._LOGGING = false;
    }
  },
  enumerable: true,
  configurable: true
});

heir.merge(OneSignal, new EventEmitter());


if (OneSignal.LOGGING)
  log.setDefaultLevel((<any>log).levels.TRACE);
else
  log.setDefaultLevel((<any>log).levels.ERROR);

log.info(`%cOneSignal Web SDK loaded (version ${OneSignal._VERSION}, ${Environment.getEnv()} environment).`, getConsoleStyle('bold'));
log.debug(`Current Page URL: ${location.href}`);
log.debug(`Browser Environment: ${Browser.name} ${Browser.version}`);

module.exports = OneSignal;

