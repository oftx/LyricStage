/**
 * MAIN-world content-script entry: always-on page clock + seek bridge.
 * Does not depend on the service worker being awake.
 */
import { installAppleMusicIdentityHooks } from '../musickit/identity-hooks.js';
import { installPageClockMainBridge } from './main.js';

// Learn catalog ids from MusicKit / network before the first clock sample.
installAppleMusicIdentityHooks();
installPageClockMainBridge({ open: true });
