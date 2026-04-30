/**
 * (c) 2026 KickedStorm (kickedstorm.com)
 * Project: AG Browser
 * License: GNU AGPLv3
 * Unauthorized copying of this file is strictly prohibited.
 */
const { contextBridge, ipcRenderer, webFrame } = require('electron');

const SAFE_PAGE_PROTOCOLS = new Set(['http:', 'https:']);
const BRIDGE_KEY = '__agSecureBridge__';
const bridgeToken = `ag-secure-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function isProtectedPage() {
  try {
    return SAFE_PAGE_PROTOCOLS.has(window.location.protocol);
  } catch {
    return false;
  }
}

function requestSyncPermission(permission, details = {}) {
  try {
    return !!ipcRenderer.sendSync('permission:sync-request', { permission, details });
  } catch {
    return false;
  }
}

async function requestPermission(permission, details = {}) {
  try {
    return !!(await ipcRenderer.invoke('permission:request', { permission, details }));
  } catch {
    return false;
  }
}

function checkPermission(permission, details = {}) {
  try {
    return ipcRenderer.sendSync('permission:sync-check', { permission, details }) === true;
  } catch {
    return false;
  }
}

function getPermissionState(permission, details = {}) {
  try {
    return String(ipcRenderer.sendSync('permission:sync-state', { permission, details }) || 'denied');
  } catch {
    return 'denied';
  }
}

function buildHookSource() {
  return `
    (() => {
      if (window.__agPrivacyGuardsInstalled__) return;
      try {
        Object.defineProperty(window, '__agPrivacyGuardsInstalled__', {
          value: true,
          configurable: false,
          enumerable: false,
          writable: false
        });
      } catch {
        window.__agPrivacyGuardsInstalled__ = true;
      }

      const BRIDGE_KEY = ${JSON.stringify(BRIDGE_KEY)};
      const BRIDGE_TOKEN = ${JSON.stringify(bridgeToken)};
      const bridge = window[BRIDGE_KEY];
      const decisionCache = new Map();

      if (!bridge || typeof bridge.requestSync !== 'function') return;

      const createSecurityError = (message) => {
        try {
          return new DOMException(message, 'SecurityError');
        } catch {
          const error = new Error(message);
          error.name = 'SecurityError';
          return error;
        }
      };

      const createNotAllowedError = (message) => {
        try {
          return new DOMException(message, 'NotAllowedError');
        } catch {
          const error = new Error(message);
          error.name = 'NotAllowedError';
          return error;
        }
      };

      const getDecisionCacheKey = (permission, details = {}) => {
        try {
          return permission + ':' + JSON.stringify(details || {});
        } catch {
          return permission;
        }
      };

      const requestPermission = (permission, details = {}) => {
        const cacheKey = getDecisionCacheKey(permission, details);
        if (decisionCache.get(cacheKey) === true) {
          return true;
        }

        const allowed = !!bridge.requestSync(BRIDGE_TOKEN, permission, {
          ...details,
          requestingUrl: window.location.href
        });
        if (allowed) {
          decisionCache.set(cacheKey, true);
        } else {
          decisionCache.delete(cacheKey);
        }
        return allowed;
      };

      const requestPermissionAsync = async (permission, details = {}) => {
        const cacheKey = getDecisionCacheKey(permission, details);
        const allowed = await bridge.requestAsync(BRIDGE_TOKEN, permission, {
          ...details,
          requestingUrl: window.location.href
        });

        if (allowed) {
          decisionCache.set(cacheKey, true);
        }

        return !!allowed;
      };

      const checkPermissionSync = (permission, details = {}) => {
        const cacheKey = getDecisionCacheKey(permission, details);
        if (decisionCache.get(cacheKey) === true) {
          return true;
        }

        return !!bridge.checkSync(BRIDGE_TOKEN, permission, {
          ...details,
          requestingUrl: window.location.href
        });
      };

      const getPermissionStateSync = (permission, details = {}) => {
        const cacheKey = getDecisionCacheKey(permission, details);
        if (decisionCache.get(cacheKey) === true) {
          return 'granted';
        }

        return String(bridge.stateSync(BRIDGE_TOKEN, permission, {
          ...details,
          requestingUrl: window.location.href
        }) || 'denied');
      };

      const getRequestedMediaTypes = (constraints = {}) => {
        const mediaTypes = [];
        if (constraints && constraints.audio) mediaTypes.push('audio');
        if (constraints && constraints.video) mediaTypes.push('video');
        return mediaTypes;
      };

      const sanitizeMediaDevice = (device) => ({
        kind: device?.kind || '',
        label: '',
        deviceId: '',
        groupId: '',
        toJSON() {
          return {
            kind: this.kind,
            label: this.label,
            deviceId: this.deviceId,
            groupId: this.groupId
          };
        }
      });

      const installReadonlyGetter = (target, property, getter) => {
        if (!target) return;
        try {
          Object.defineProperty(target, property, {
            configurable: false,
            enumerable: false,
            get: getter
          });
        } catch {
          // Ignore targets that do not allow overriding.
        }
      };

      const wrapMethod = (target, property, createWrapper) => {
        if (!target) return;
        const original = target[property];
        if (typeof original !== 'function' || original.__agSecureWrapped__) return;

        const wrapped = createWrapper(original);
        try {
          Object.defineProperty(wrapped, '__agSecureWrapped__', {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false
          });
        } catch {
          wrapped.__agSecureWrapped__ = true;
        }

        try {
          Object.defineProperty(target, property, {
            configurable: false,
            enumerable: false,
            writable: false,
            value: wrapped
          });
        } catch {
          try {
            target[property] = wrapped;
          } catch {
            // Ignore targets that cannot be overridden.
          }
        }
      };

      const resolvePermissionQuery = (descriptor = {}) => {
        const queryName = descriptor && typeof descriptor === 'object'
          ? String(descriptor.name || '')
          : '';

        switch (queryName) {
          case 'microphone':
            return {
              queryName,
              permission: 'media',
              details: {
                mediaType: 'audio',
                mediaTypes: ['audio']
              }
            };
          case 'camera':
            return {
              queryName,
              permission: 'media',
              details: {
                mediaType: 'video',
                mediaTypes: ['video']
              }
            };
          case 'speaker-selection':
            return {
              queryName,
              permission: 'speaker-selection',
              details: {}
            };
          default:
            return null;
        }
      };

      const createPermissionStatus = (name, state) => {
        const eventTarget = typeof EventTarget === 'function'
          ? new EventTarget()
          : document.createDocumentFragment();
        let onchange = null;

        const status = {
          get name() {
            return name;
          },
          get state() {
            return state;
          },
          get onchange() {
            return onchange;
          },
          set onchange(handler) {
            onchange = typeof handler === 'function' ? handler : null;
          },
          addEventListener(...args) {
            return eventTarget.addEventListener(...args);
          },
          removeEventListener(...args) {
            return eventTarget.removeEventListener(...args);
          },
          dispatchEvent(event) {
            const result = eventTarget.dispatchEvent(event);
            if (event?.type === 'change' && typeof onchange === 'function') {
              try {
                onchange.call(status, event);
              } catch {
                // Ignore onchange handlers that throw.
              }
            }
            return result;
          }
        };

        if (window.PermissionStatus && window.PermissionStatus.prototype) {
          try {
            Object.setPrototypeOf(status, window.PermissionStatus.prototype);
          } catch {
            // Ignore runtimes that do not allow prototype reassignment.
          }
        }

        if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
          try {
            Object.defineProperty(status, Symbol.toStringTag, {
              value: 'PermissionStatus',
              configurable: true
            });
          } catch {
            // Ignore runtimes that do not allow redefining toStringTag.
          }
        }

        return status;
      };

      const findCookieDescriptor = () => {
        const candidates = [
          window.Document && window.Document.prototype,
          window.HTMLDocument && window.HTMLDocument.prototype,
          document && document.constructor && document.constructor.prototype
        ].filter(Boolean);

        for (const candidate of candidates) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, 'cookie');
          if (descriptor && typeof descriptor.get === 'function' && typeof descriptor.set === 'function') {
            return { candidate, descriptor };
          }
        }

        return null;
      };

      const cookieDescriptor = findCookieDescriptor();
      if (cookieDescriptor) {
        try {
          Object.defineProperty(cookieDescriptor.candidate, 'cookie', {
            configurable: false,
            enumerable: cookieDescriptor.descriptor.enumerable,
            get() {
              if (!requestPermission('cookies', {
                operation: 'read',
                source: 'document.cookie'
              })) {
                return '';
              }
              return cookieDescriptor.descriptor.get.call(this);
            },
            set(value) {
              if (!requestPermission('cookies', {
                operation: 'write',
                source: 'document.cookie'
              })) {
                return value;
              }
              return cookieDescriptor.descriptor.set.call(this, value);
            }
          });
        } catch {
          // Ignore targets that cannot be overridden.
        }
      }

      installReadonlyGetter(window.Navigator && window.Navigator.prototype, 'doNotTrack', () => '1');
      installReadonlyGetter(window.Navigator && window.Navigator.prototype, 'globalPrivacyControl', () => true);
      installReadonlyGetter(window, 'doNotTrack', () => '1');

      const guardCanvasRead = (source) => {
        const allowed = requestPermission('canvas-read', { source });
        if (!allowed) {
          throw createSecurityError('The user denied access to canvas pixel data.');
        }
      };

      wrapMethod(window.HTMLCanvasElement && window.HTMLCanvasElement.prototype, 'toDataURL', (original) => function(...args) {
        guardCanvasRead('HTMLCanvasElement.toDataURL');
        return original.apply(this, args);
      });

      wrapMethod(window.HTMLCanvasElement && window.HTMLCanvasElement.prototype, 'toBlob', (original) => function(callback, ...args) {
        if (!requestPermission('canvas-read', { source: 'HTMLCanvasElement.toBlob' })) {
          if (typeof callback === 'function') {
            queueMicrotask(() => callback(null));
          }
          return;
        }
        return original.call(this, callback, ...args);
      });

      wrapMethod(window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype, 'getImageData', (original) => function(...args) {
        guardCanvasRead('CanvasRenderingContext2D.getImageData');
        return original.apply(this, args);
      });

      wrapMethod(window.OffscreenCanvasRenderingContext2D && window.OffscreenCanvasRenderingContext2D.prototype, 'getImageData', (original) => function(...args) {
        guardCanvasRead('OffscreenCanvasRenderingContext2D.getImageData');
        return original.apply(this, args);
      });

      wrapMethod(window.OffscreenCanvas && window.OffscreenCanvas.prototype, 'convertToBlob', (original) => function(...args) {
        if (!requestPermission('canvas-read', { source: 'OffscreenCanvas.convertToBlob' })) {
          return Promise.reject(createSecurityError('The user denied access to canvas pixel data.'));
        }
        return original.apply(this, args);
      });

      wrapMethod(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype, 'readPixels', (original) => function(...args) {
        guardCanvasRead('WebGLRenderingContext.readPixels');
        return original.apply(this, args);
      });

      wrapMethod(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype, 'readPixels', (original) => function(...args) {
        guardCanvasRead('WebGL2RenderingContext.readPixels');
        return original.apply(this, args);
      });

      wrapMethod(window.Permissions && window.Permissions.prototype, 'query', (original) => function(descriptor = {}) {
        const mappedQuery = resolvePermissionQuery(descriptor);
        if (!mappedQuery) {
          return original.call(this, descriptor);
        }

        return Promise.resolve(
          createPermissionStatus(
            mappedQuery.queryName,
            getPermissionStateSync(mappedQuery.permission, mappedQuery.details)
          )
        );
      });

      wrapMethod(window.MediaDevices && window.MediaDevices.prototype, 'getUserMedia', (original) => async function(constraints = {}) {
        const mediaTypes = getRequestedMediaTypes(constraints);
        const allowed = await requestPermissionAsync('media', {
          mediaTypes,
          mediaType: mediaTypes.length === 1 ? mediaTypes[0] : 'unknown'
        });

        if (!allowed) {
          throw createNotAllowedError('The user denied access to media devices.');
        }

        return original.call(this, constraints);
      });

      wrapMethod(window.MediaDevices && window.MediaDevices.prototype, 'enumerateDevices', (original) => async function(...args) {
        const devices = await original.apply(this, args);
        const canExposeAudioInput = checkPermissionSync('media', { mediaType: 'audio' });
        const canExposeVideoInput = checkPermissionSync('media', { mediaType: 'video' });
        const canExposeAudioOutput = checkPermissionSync('speaker-selection');

        return devices.map((device) => {
          if (device?.kind === 'audioinput' && canExposeAudioInput) return device;
          if (device?.kind === 'videoinput' && canExposeVideoInput) return device;
          if (device?.kind === 'audiooutput' && canExposeAudioOutput) return device;
          return sanitizeMediaDevice(device);
        });
      });
    })();
  `;
}

function injectHookIntoMainWorld(source) {
  try {
    const parent = document.documentElement || document.head;
    if (parent) {
      const script = document.createElement('script');
      script.textContent = source;
      parent.prepend(script);
      script.remove();
    }
  } catch {
    // Fall back to executeJavaScript below.
  }

  void webFrame.executeJavaScript(source, true).catch(() => {});
}

if (isProtectedPage()) {
  contextBridge.exposeInMainWorld(BRIDGE_KEY, Object.freeze({
    requestSync: (token, permission, details) => {
      if (token !== bridgeToken) return false;
      return requestSyncPermission(permission, details);
    },
    requestAsync: (token, permission, details) => {
      if (token !== bridgeToken) return Promise.resolve(false);
      return requestPermission(permission, details);
    },
    checkSync: (token, permission, details) => {
      if (token !== bridgeToken) return false;
      return checkPermission(permission, details);
    },
    stateSync: (token, permission, details) => {
      if (token !== bridgeToken) return 'denied';
      return getPermissionState(permission, details);
    }
  }));

  injectHookIntoMainWorld(buildHookSource());
}
